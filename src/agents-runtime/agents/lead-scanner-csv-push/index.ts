import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadCsvAndSign } from "@/lib/storage";
import { postSlackMessage } from "@/lib/slack";
import { alertExportFailed72h } from "@/lib/safety-alerts";
import { buildSupplierCsv, normalizeSupplierKey, type LeadRow } from "./csv-builder";

// Dropped-lead CSVs post to the ops group channel (#op-assistant-agents) — the
// same channel the QA Watchdog uses — so the handoff is visible to the team
// instead of buried in a private DM. Falls back to the shared escalation
// channel; override via LEAD_SCANNER_SLACK_CHANNEL_ID to re-target.
const LEAD_SCANNER_CHANNEL_ID =
  process.env.LEAD_SCANNER_SLACK_CHANNEL_ID ?? process.env.SLACK_ESCALATION_CHANNEL_ID;
const BUCKET = "lead-scanner-csvs";

// v1 trims (see migration 0009 and SESSION-04 report):
//   - dedup at supplier_id level over a rolling 7-day window
//   - skip suppliers with <2 leads if mean confidence < 0.4 (noise floor)
//   - no Slack reaction listener; we POST and mark 'sent'
//   - no 24h/72h follow-up sweep
const RECENT_EXPORT_DAYS = 7;
const MIN_LEADS_LOW_CONF = 2;
const LOW_CONF_THRESHOLD = 0.4;

registerAgent({
  slug: "agent-11-lead-scanner-csv-push",
  displayName: "Agent 11 - Lead Scanner CSV Push",
  description: "Daily per-supplier CSV handoff to Andrew.",
  async run(ctx) {
    const admin = createAdminClient();

    // 0. Sweep "sent" exports older than 72h that Andrew never acked → mark failed + alert Sam.
    const failCutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const { data: stale } = await admin
      .from("lead_scanner_exports")
      .select("id, supplier_name, supplier_id, generated_at")
      .eq("status", "sent")
      .lt("generated_at", failCutoff);
    if (stale && stale.length > 0) {
      await admin
        .from("lead_scanner_exports")
        .update({ status: "failed", error: "no_ack_72h" })
        .in("id", stale.map((s: any) => s.id));
      for (const s of stale as any[]) {
        alertExportFailed72h({
          exportId: s.id,
          supplierName: s.supplier_name,
          supplierId: s.supplier_id,
          generatedAt: s.generated_at,
        }).catch((e) => console.error("[safety-alerts] export 72h alert failed:", e));
      }
      await ctx.log(`Marked ${stale.length} stale 'sent' exports as failed (Andrew no-ack 72h).`, { step: "no_ack_sweep" });
    }

    // 1. Pull dropped/terminal leads from leads_in_flight.
    const { data: leadsRaw, error: leadsErr } = await admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, agent_run_id, drop_reason, confidence_score, created_at")
      .in("status", ["dropped", "terminal"]);
    if (leadsErr) {
      await ctx.log(`leads_in_flight query failed: ${leadsErr.message}`, { level: "error", step: "query" });
      ctx.setStatus("failure");
      ctx.setSummary(`Lead query failed: ${leadsErr.message}`);
      return;
    }
    const leads = (leadsRaw ?? []) as LeadRow[];
    await ctx.log(`${leads.length} dropped/terminal leads found`, { step: "query", data: { count: leads.length } });

    if (leads.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setSummary("No dropped/terminal leads to export.");
      ctx.setStatus("success");
      return;
    }

    // 2. Load recent exports for supplier-level dedup (v1 trim).
    const since = new Date(Date.now() - RECENT_EXPORT_DAYS * 24 * 3600 * 1000).toISOString();
    const { data: recentExports } = await admin
      .from("lead_scanner_exports")
      .select("supplier_id, status, generated_at")
      .gte("generated_at", since)
      .neq("status", "failed");
    const recentSupplierIds = new Set(
      (recentExports ?? []).map((r: any) => r.supplier_id).filter((x: any) => x != null)
    );
    await ctx.log(`${recentSupplierIds.size} suppliers already exported in last ${RECENT_EXPORT_DAYS}d (dedup)`, {
      step: "dedup",
      data: { suppliers_skipped: Array.from(recentSupplierIds) },
    });

    // 3. Group by supplier (case-insensitive, trimmed). One CSV per supplier.
    const groups = new Map<string, { supplier_name: string; supplier_id: string | null; rows: LeadRow[] }>();
    for (const lead of leads) {
      const sid = lead.supplier_id;
      if (sid && recentSupplierIds.has(sid)) continue;
      const key = sid ?? `name:${normalizeSupplierKey(lead.supplier_name)}`;
      let g = groups.get(key);
      if (!g) {
        g = { supplier_name: lead.supplier_name ?? "(unknown supplier)", supplier_id: sid, rows: [] };
        groups.set(key, g);
      }
      g.rows.push(lead);
    }
    await ctx.log(`${groups.size} supplier groups after dedup`, { step: "group" });

    // 4. Apply noise-floor rule + export per group.
    let exported = 0;
    let skippedNoisy = 0;
    let slackFailures = 0;
    const summaries: string[] = [];

    for (const [key, group] of groups.entries()) {
      const meanConf =
        group.rows.reduce((sum, r) => sum + (r.confidence_score ?? 0), 0) / group.rows.length;
      if (group.rows.length < MIN_LEADS_LOW_CONF && meanConf < LOW_CONF_THRESHOLD) {
        skippedNoisy++;
        await ctx.log(
          `Skipping ${group.supplier_name}: ${group.rows.length} leads @ mean conf ${meanConf.toFixed(2)} (under noise floor)`,
          { step: "filter", data: { supplier: group.supplier_name, count: group.rows.length, mean_conf: meanConf } }
        );
        continue;
      }

      // 4a. Build CSV.
      const csv = buildSupplierCsv(group.rows);
      const safeName = group.supplier_name.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);
      const filename = `${safeName}-${Date.now()}.csv`;

      // 4b. Upload to bucket.
      let stored;
      try {
        stored = await uploadCsvAndSign({ filename, content: csv, bucket: BUCKET, expiresInDays: 7 });
      } catch (e: any) {
        await ctx.log(`Storage upload failed for ${group.supplier_name}: ${e.message}`, {
          level: "error",
          step: "upload",
          data: { supplier: group.supplier_name },
        });
        continue;
      }

      // 4c. Insert the export row (status starts queued, flips to sent on Slack ok).
      const { data: exportRow, error: insErr } = await admin
        .from("lead_scanner_exports")
        .insert({
          supplier_name: group.supplier_name,
          supplier_id: group.supplier_id,
          csv_payload: stored.path,
          status: "queued",
          generated_by_agent: ctx.agentId,
        })
        .select("id")
        .single();
      if (insErr || !exportRow) {
        await ctx.log(`Export row insert failed for ${group.supplier_name}: ${insErr?.message}`, {
          level: "error",
          step: "insert",
        });
        continue;
      }

      // 4d. Slack notification to the ops group channel with the CSV link.
      const text =
        `*Dropped leads for ${group.supplier_name}* — ${group.rows.length} material${group.rows.length === 1 ? "" : "s"}, ` +
        `generated by Agent 11. Upload to Lead Scanner when ready.\n` +
        `CSV (signed, expires ${new Date(stored.expiresAt).toISOString().slice(0, 10)}): ${stored.signedUrl}`;
      const slackRes = await postSlackMessage({ channel: LEAD_SCANNER_CHANNEL_ID, text });
      if (!slackRes.ok) {
        slackFailures++;
        await ctx.log(`Slack post failed: ${slackRes.error}`, {
          level: "warn",
          step: "slack",
          data: { supplier: group.supplier_name, error: slackRes.error },
        });
        await admin
          .from("lead_scanner_exports")
          .update({ status: "failed", error: `slack: ${slackRes.error}` })
          .eq("id", exportRow.id);
        continue;
      }

      await admin
        .from("lead_scanner_exports")
        .update({ status: "sent", slack_message_ts: slackRes.ts })
        .eq("id", exportRow.id);

      exported++;
      summaries.push(`${group.supplier_name} (${group.rows.length})`);
      await ctx.log(`Exported ${group.supplier_name}: ${group.rows.length} leads → Slack ${slackRes.ts}`, {
        step: "export",
        data: { supplier: group.supplier_name, count: group.rows.length, slack_ts: slackRes.ts, csv_path: stored.path },
      });
    }

    ctx.setItemsProcessed(exported);
    ctx.setStatus(slackFailures > 0 ? "partial" : "success");
    ctx.setSummary(
      `Exported ${exported} supplier CSV${exported === 1 ? "" : "s"} to Andrew · ` +
        `skipped ${recentSupplierIds.size} as recent · ${skippedNoisy} as noisy · ${slackFailures} Slack failures` +
        (summaries.length ? ` · ${summaries.slice(0, 5).join(", ")}${summaries.length > 5 ? "…" : ""}` : "")
    );
  },
});
