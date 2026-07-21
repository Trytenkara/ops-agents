import type { createAdminClient } from "@/lib/supabase/admin";
import { recheckMarketplaceQuote } from "./price-recheck";
import { convertToUsd } from "@/lib/fx";
import { getOrgOperatorPool, getSupplierAssignments, resolveSupplierOperatorId } from "@/lib/operator-assignment";

type Admin = ReturnType<typeof createAdminClient>;

// #4 — marketplace pricing. New marketplace leads carry a listing URL but no
// pulled price. Attempt to auto-pull the listed price (reusing the same
// web_search recheck Agent 05 runs on expiring quotes); on success stamp the
// price onto the lead so it's populated in the pipeline, on failure (login
// wall, broken link, nothing found) flag the lead and open a case tagging the
// lead's operator to pull it by hand. Read-only on Tenkara — writes only to OA
// leads_in_flight.payload + cases.

const LEAD_CAP = 12;      // Opus+web_search per lead (~25s) — keep well inside budget.
const CONCURRENCY = 4;

interface LeadRow {
  id: string;
  org_id: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  material_id: string | null;
  material_name: string | null;
  payload: any;
}

function listingUrl(payload: any): string | null {
  return (
    (payload?.enrichment?.contact?.contact_url as string | undefined) ??
    (payload?.supplier_website as string | undefined) ??
    (payload?.source_url as string | undefined) ??
    null
  );
}

export interface LeadPullResult {
  processed: number;
  pulled: number;
  flagged: number;
  stoppedEarly: boolean;
}

export async function pullPricesForNewMarketplaceLeads(opts: {
  admin: Admin;
  runId: string;
  deadline: number;
  log: (msg: string, meta?: any) => Promise<void> | void;
}): Promise<LeadPullResult> {
  const { admin, runId, deadline, log } = opts;
  const empty: LeadPullResult = { processed: 0, pulled: 0, flagged: 0, stoppedEarly: false };
  if (Date.now() > deadline) return empty;

  // Active marketplace leads with no pull attempt yet. Marketplace is signalled
  // by the scanner's site_type (M/MS) or an explicit Marketplace role.
  const { data: rows, error } = await admin
    .from("leads_in_flight")
    .select("id, org_id, supplier_id, supplier_name, material_id, material_name, payload")
    .eq("status", "active")
    .is("payload->marketplace_pull", null)
    .or("payload->>site_type.in.(M,MS),payload->>supplier_role.eq.Marketplace")
    .limit(LEAD_CAP * 3);
  if (error) {
    await log(`Marketplace lead query failed (non-fatal): ${error.message}`, { level: "warn", step: "mp_leads" });
    return empty;
  }

  const leads = ((rows ?? []) as LeadRow[]).filter((l) => l.material_name && listingUrl(l.payload)).slice(0, LEAD_CAP);
  if (leads.length === 0) return empty;

  // Operator pool + assignments per org, for tagging the flag case.
  const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
  const poolByOrg = new Map<string, any[]>();
  const assignByOrg = new Map<string, Map<string, string>>();
  const primaryByOrg = new Map<string, string | null>();
  for (const oid of orgIds) {
    poolByOrg.set(oid, await getOrgOperatorPool(admin, oid).catch(() => []));
    assignByOrg.set(oid, await getSupplierAssignments(admin, oid).catch(() => new Map()));
    const { data: org } = await admin.from("orgs").select("primary_user_id").eq("id", oid).maybeSingle();
    primaryByOrg.set(oid, org?.primary_user_id ?? null);
  }
  const operatorFor = (l: LeadRow): string | null => {
    if (!l.org_id) return null;
    return (
      resolveSupplierOperatorId(assignByOrg.get(l.org_id) ?? new Map(), poolByOrg.get(l.org_id) ?? [], l.supplier_id) ??
      primaryByOrg.get(l.org_id) ??
      null
    );
  };

  let processed = 0;
  let pulled = 0;
  let flagged = 0;
  let stoppedEarly = false;

  const processOne = async (l: LeadRow): Promise<"pulled" | "flagged" | null> => {
    const url = listingUrl(l.payload)!;
    let result;
    try {
      result = await recheckMarketplaceQuote({
        supplier_name: l.supplier_name ?? "",
        material_name: l.material_name ?? "",
        product_url: url,
        baseline_price: null,
        case_size: null,
        unit: null,
      });
    } catch (e: any) {
      result = { classification: "needs_review" as const, current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], source_url: url, source_citations: [], notes: `pull failed: ${e?.message ?? e}` };
    }

    // Normalize a listed non-USD price to USD so the populated number is comparable.
    if (result.currency && result.currency !== "USD" && result.current_price != null) {
      const conv = await convertToUsd(result.current_price, result.currency).catch(() => null);
      if (conv) {
        result.current_price = conv.usd;
        if (result.unit_price != null) {
          const u = await convertToUsd(result.unit_price, result.currency).catch(() => null);
          if (u) result.unit_price = u.usd;
        }
      }
    }

    const gotPrice = result.classification === "current_price_found" && result.current_price != null;
    const pull = gotPrice
      ? {
          status: "pulled" as const,
          unit_price: result.unit_price,
          price: result.current_price,
          pack_size: result.pack_size,
          currency: "USD",
          source_url: result.source_url ?? url,
          pulled_at: new Date().toISOString(),
        }
      : {
          status: "needs_manual_pull" as const,
          reason: result.classification, // login_required | link_broken | needs_review
          source_url: result.source_url ?? url,
          at: new Date().toISOString(),
        };

    // Populate the same price_tiers the Marketplace-pricing tab renders — but
    // never clobber tiers an operator already entered.
    const nextPayload: any = { ...(l.payload ?? {}), marketplace_pull: pull };
    const existingTiers = Array.isArray(l.payload?.price_tiers) ? l.payload.price_tiers : [];
    if (gotPrice && existingTiers.length === 0) {
      const tiers = result.tiers.length
        ? result.tiers.map((t) => ({ pack_size: t.pack_size ?? "", price: t.price ?? null, unit_price: t.unit_price ?? null }))
        : [{ pack_size: result.pack_size ?? "", price: result.current_price, unit_price: result.unit_price }];
      nextPayload.price_tiers = tiers;
      nextPayload.price_tiers_updated_at = new Date().toISOString();
    }

    const { error: upErr } = await admin
      .from("leads_in_flight")
      .update({ payload: nextPayload })
      .eq("id", l.id);
    if (upErr) {
      await log(`Lead payload update failed for ${l.id}: ${upErr.message}`, { level: "error", step: "mp_leads", data: { lead_id: l.id } });
      return null;
    }

    if (gotPrice) {
      await log(`Pulled marketplace price: ${l.supplier_name} × ${l.material_name} → $${result.current_price}${result.pack_size ? ` / ${result.pack_size}` : ""}`, {
        step: "mp_pull",
        data: { lead_id: l.id },
      });
      return "pulled";
    }

    // Flag + tag the operator with a case, unless one is already open.
    const { data: dupe } = await admin
      .from("cases")
      .select("id")
      .eq("org_id", l.org_id)
      .eq("type", "marketplace_price_pull")
      .eq("supplier_id", l.supplier_id)
      .eq("material_id", l.material_id)
      .eq("status", "open")
      .maybeSingle();
    if (!dupe) {
      const reasonLabel =
        pull.reason === "login_required" ? "the listing needs a login/account"
        : pull.reason === "link_broken" ? "the listing link is broken"
        : "no price was found on the page";
      await admin.from("cases").insert({
        org_id: l.org_id,
        type: "marketplace_price_pull",
        status: "open",
        supplier_id: l.supplier_id,
        material_id: l.material_id,
        recommended_action: `Marketplace price for ${l.material_name} from ${l.supplier_name ?? "this supplier"} couldn't be auto-pulled — ${reasonLabel}. Pull the listed/wholesale price manually: ${pull.source_url}`,
        assigned_operator: operatorFor(l),
        metadata: {
          source_agent: "agent-05-marketplace-validation",
          source_run_id: runId,
          lead_id: l.id,
          supplier_name: l.supplier_name,
          material_name: l.material_name,
          reason: pull.reason,
          source_url: pull.source_url,
        },
      });
    }
    await log(`Marketplace price needs manual pull (${pull.reason}): ${l.supplier_name} × ${l.material_name}`, {
      step: "mp_flag",
      data: { lead_id: l.id, reason: pull.reason },
    });
    return "flagged";
  };

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      stoppedEarly = true;
      break;
    }
    const batch = leads.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(batch.map((l) => processOne(l)));
    for (const o of outcomes) {
      if (o == null) continue;
      processed++;
      if (o === "pulled") pulled++;
      else flagged++;
    }
  }

  return { processed, pulled, flagged, stoppedEarly };
}
