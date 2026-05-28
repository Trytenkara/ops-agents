import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { uploadCsvAndSign } from "@/lib/storage";
import { buildCsv, type ValidationRow } from "./csv-builder";

// v1: re-verify catalog-match leads. Agent 03 finds suppliers via four signals;
// `catalog_match` (the supplier listed the material in their uploaded catalog)
// is the only one that depends on a separate Tenkara table — supplier_catalog_materials.
// That data drifts: suppliers re-upload catalogs, remove SKUs, etc.
//
// For each lead with signal='catalog_match' (regardless of stage), we check
// whether the supplier still lists the material by INCI or product name. If
// not, we set payload.catalog_drift so the human reviewer knows the original
// signal no longer holds. We never drop the lead — that's a human call.
const MAX_LEADS_PER_RUN = 50;

interface LeadRow {
  id: string;
  supplier_id: string | null;
  material_name: string | null;
  payload: Record<string, any> | null;
}

interface CatalogRow {
  hit_count: number;
}

async function supplierStillListsMaterial(
  supplierId: string,
  inci: string | null,
  nameKey: string | null
): Promise<boolean> {
  // Same OR-conditions as Agent 03's catalog signal query, scoped to one
  // supplier so it's cheap.
  const rows = await tenkaraQuery<CatalogRow>(
    `select count(*)::int as hit_count
       from public.supplier_catalog_materials scm
      where scm.supplier_id = $1::uuid
        and ( ($2::text is not null and lower(scm.inci) = lower($2::text))
           or ($3::text is not null and (
               lower(coalesce(scm.product_name,'')) = lower($3::text)
            or lower(coalesce(scm.trade_name,''))   = lower($3::text)
           ))
        )`,
    [supplierId, inci, nameKey]
  );
  return (rows[0]?.hit_count ?? 0) > 0;
}

registerAgent({
  slug: "agent-05-marketplace-validation",
  displayName: "Agent 05 - Marketplace Validation",
  description:
    "Re-verifies catalog-match leads against Tenkara's current catalog. Flags payload.catalog_drift when a supplier no longer lists a material we sourced from them.",
  async run(ctx) {
    const admin = createAdminClient();

    // Pull leads whose original signal was catalog_match. We use a JSON filter;
    // PostgREST supports it via `payload->>signal=eq.catalog_match`.
    const { data: leads, error: pullErr } = await admin
      .from("leads_in_flight")
      .select("id, supplier_id, material_name, payload")
      .filter("payload->>signal", "eq", "catalog_match")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(MAX_LEADS_PER_RUN);

    if (pullErr) {
      await ctx.log(`Pull failed: ${pullErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${pullErr.message}`);
      return;
    }
    if (!leads || leads.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No catalog_match leads to validate.");
      return;
    }
    await ctx.log(`Validating ${leads.length} catalog_match leads`, { step: "pull" });

    let stillListed = 0;
    let drifted = 0;
    let skipped = 0;
    let errored = 0;
    const csvRows: ValidationRow[] = [];

    for (const row of leads as LeadRow[]) {
      const payload = row.payload ?? {};
      const inci = (payload.inci_name as string | undefined) ?? null;
      const nameKey = row.material_name ?? null;
      if (!row.supplier_id || (!inci && !nameKey)) {
        skipped++;
        continue;
      }

      let listed: boolean;
      try {
        listed = await supplierStillListsMaterial(row.supplier_id, inci, nameKey);
      } catch (e: any) {
        errored++;
        await ctx.log(`Tenkara query failed for lead ${row.id}: ${e.message}`, {
          level: "warn",
          step: "tenkara",
          data: { lead_id: row.id },
        });
        continue;
      }

      const nowIso = new Date().toISOString();
      const validation = {
        last_checked_at: nowIso,
        last_checked_run_id: ctx.runId,
        still_listed: listed,
      };

      // Only update if state changed — avoids touchy updated_at churn.
      const prev = payload.catalog_validation as { still_listed?: boolean } | undefined;
      const stateChanged = !prev || prev.still_listed !== listed;

      if (listed) {
        stillListed++;
      } else {
        drifted++;
      }

      csvRows.push({
        lead_id: row.id,
        supplier_id: row.supplier_id,
        supplier_name: null,
        material_name: nameKey,
        inci,
        still_listed: listed,
        previous_still_listed: prev?.still_listed ?? null,
        state_changed: stateChanged,
        last_checked_at: nowIso,
      });

      if (!stateChanged) {
        // Still update the last_checked_at timestamp so we can prove the run touched it.
        await admin
          .from("leads_in_flight")
          .update({
            payload: {
              ...payload,
              catalog_validation: { ...validation, still_listed: listed },
            },
          })
          .eq("id", row.id);
        continue;
      }

      const newPayload = {
        ...payload,
        catalog_validation: validation,
        catalog_drift: listed ? null : "no_longer_listed",
      };
      const { error: upErr } = await admin
        .from("leads_in_flight")
        .update({ payload: newPayload })
        .eq("id", row.id);
      if (upErr) {
        errored++;
        await ctx.log(`Update failed for lead ${row.id}: ${upErr.message}`, {
          level: "error",
          step: "update",
          data: { lead_id: row.id },
        });
        continue;
      }
      await ctx.log(
        `${listed ? "Still listed" : "Drifted"}: supplier ${row.supplier_id} × ${nameKey ?? inci}`,
        { step: "validate", data: { lead_id: row.id, still_listed: listed } }
      );
    }

    // Hydrate supplier names from Tenkara for the CSV.
    if (csvRows.length > 0) {
      const supplierIds = Array.from(new Set(csvRows.map((r) => r.supplier_id)));
      try {
        const suppliers = await tenkaraQuery<{ id: string; name: string | null }>(
          `select id::text as id, name from public.suppliers where id = any($1::uuid[])`,
          [supplierIds]
        );
        const nameById = new Map(suppliers.map((s) => [s.id, s.name]));
        for (const r of csvRows) r.supplier_name = nameById.get(r.supplier_id) ?? null;
      } catch (e: any) {
        await ctx.log(`Supplier name hydration failed: ${e.message}`, { level: "warn", step: "csv" });
      }
    }

    // Build + upload CSV. Bucket shared with Agent 02 — filename keeps it distinct.
    if (csvRows.length > 0) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const csvContent = buildCsv(csvRows);
        const csvFilename = `${today}_marketplace_validation_${stillListed}listed_${drifted}drifted.csv`;
        const signed = await uploadCsvAndSign({
          filename: csvFilename,
          content: csvContent,
          expiresInDays: 7,
        });
        await ctx.log(`CSV uploaded → ${signed.signedUrl}`, { step: "csv", data: { url: signed.signedUrl } });
        ctx.setMetadata({
          csvSignedUrl: signed.signedUrl,
          csvFilename,
          csvExpiresAt: signed.expiresAt,
        });
      } catch (e: any) {
        await ctx.log(`CSV upload failed: ${e.message}`, { level: "warn", step: "csv" });
      }
    }

    ctx.setItemsProcessed(stillListed + drifted);
    ctx.setStatus(errored > 0 && stillListed + drifted === 0 ? "failure" : errored > 0 ? "partial" : "success");
    ctx.setSummary(
      `Validated ${stillListed + drifted} catalog_match leads · ${stillListed} still listed · ${drifted} drifted${skipped ? ` · ${skipped} skipped (missing fields)` : ""}${errored ? ` · ${errored} errors` : ""}`
    );
  },
});
