import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadOrgStatuses, sourcingAllowed } from "@/lib/org-status";
import { loadOrgTimingMap, filterDueOrgIds, recordOrgRuns } from "@/lib/org-tier";
import type { RawLead } from "./enrich";
import { enrichAndStageLead } from "./run-enrich";

// v1 trim (vs. full spec):
//   - pre-outreach only. Reply-driven enrichment lands when Agent 08
//     (Email Scanner) ships.
//   - cron-style sweep of stage='raw' & status='active' leads, ordered by
//     confidence_score DESC so the most promising candidates get enriched first.
//   - cap 25 leads/run. The probe step is network-bound (HEAD requests with
//     8s timeout each), so 25 keeps us comfortably under the 300s Vercel
//     Hobby maxDuration even in worst-case all-timeout scenarios.
const MAX_LEADS_PER_RUN = 25;

registerAgent({
  slug: "agent-06-enrichment",
  displayName: "Agent 06 - Data Enrichment",
  description:
    "Pre-outreach enrichment. Sweeps stage=raw leads, probes supplier website + contact email, merges Tenkara supplier metadata, then promotes to stage=enriched for human review.",
  async run(ctx) {
    const admin = createAdminClient();

    // Per-org switch: only enrich leads for orgs whose sourcing_status allows
    // pool-building (active or sourcing_only). 'off' orgs are skipped entirely.
    const orgStatuses = await loadOrgStatuses(admin);
    const allSourcingOrgIds = [...orgStatuses.byOaId.entries()].filter(([, s]) => sourcingAllowed(s)).map(([id]) => id);
    const timingMap06 = await loadOrgTimingMap(admin, "agent-06-enrichment", allSourcingOrgIds);
    const sourcingOrgIds = filterDueOrgIds(allSourcingOrgIds, timingMap06, "agent-06-enrichment");
    if (sourcingOrgIds.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(allSourcingOrgIds.length ? "All orgs throttled by tier — not due yet." : "No orgs are active/sourcing_only — nothing to enrich.");
      return;
    }

    // 1. Pull a batch of raw leads: never-attempted first, then whatever was tried
    //    longest ago, with confidence breaking ties inside each group.
    //
    //    Ordering on confidence alone deadlocked this sweep: a blocked lead stays at
    //    stage=raw and its score never moves, so once 25 of them collected at the top
    //    of a tier the same rows were re-selected every run and promotion sat at zero
    //    for days. The attempt timestamp is mutated by every attempt, so a lead
    //    physically cannot be re-selected ahead of untried work, and blocked leads
    //    come back for a retry only after the queue has cycled.
    const { data: leads, error: pullErr } = await admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_id, supplier_name, material_name, payload, confidence_score")
      .eq("stage", "raw")
      .eq("status", "active")
      .in("org_id", sourcingOrgIds)
      .order("last_enrichment_attempt_at", { ascending: true, nullsFirst: true })
      .order("confidence_score", { ascending: false, nullsFirst: false })
      .limit(MAX_LEADS_PER_RUN);

    if (pullErr) {
      await ctx.log(`Failed to pull raw leads: ${pullErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${pullErr.message}`);
      return;
    }

    if (!leads || leads.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No raw leads to enrich.");
      return;
    }

    await ctx.log(`Enriching ${leads.length} raw leads`, { step: "pull", data: { count: leads.length } });

    // 2. Enrich each lead. Contact discovery now fetches multiple pages per
    //    supplier, so we run leads in small concurrent batches (different
    //    suppliers = different hosts, so this doesn't hammer any one site) and
    //    stop starting new work past a wall-clock deadline. Anything we don't
    //    reach stays at stage=raw and gets picked up on the next run.
    let promoted = 0;
    let blocked = 0;
    let errored = 0;
    let skipped = 0;
    // Lead changed state mid-probe (operator action in the Control Room), so this
    // run's write was declined rather than clobbering it.
    let superseded = 0;
    const blockedReasons: Record<string, number> = {};
    const startedAt = Date.now();

    type LeadRow = { id: string; supplier_id: string | null; supplier_name: string | null; material_name: string | null; payload: any; confidence_score: number | null };
    async function processLead(row: LeadRow): Promise<void> {
      const lead: RawLead = {
        id: row.id,
        supplier_id: row.supplier_id,
        supplier_name: row.supplier_name,
        material_name: row.material_name,
        payload: row.payload ?? {},
        confidence_score: row.confidence_score,
      };
      const outcome = await enrichAndStageLead(lead, { admin, runId: ctx.runId, log: (m, meta) => ctx.log(m, meta) });
      if (outcome.status === "promoted") {
        promoted++;
        await ctx.log(`Promoted ${lead.supplier_name} → ${lead.material_name} (score ${outcome.completeness})`, {
          step: "promote",
          data: { lead_id: lead.id, completeness_score: outcome.completeness },
        });
      } else if (outcome.status === "blocked") {
        blocked++;
        const reason = outcome.reason ?? "unknown";
        blockedReasons[reason] = (blockedReasons[reason] ?? 0) + 1;
      } else if (outcome.status === "superseded") {
        superseded++;
      } else {
        errored++;
      }
    }

    const CONCURRENCY = 5;
    const DEADLINE_MS = 230_000; // leave headroom under the 300s function limit
    for (let i = 0; i < leads.length; i += CONCURRENCY) {
      if (Date.now() - startedAt > DEADLINE_MS) {
        skipped = leads.length - i;
        await ctx.log(`Deadline reached — leaving ${skipped} leads at raw for the next run`, { step: "deadline" });
        break;
      }
      await Promise.all(leads.slice(i, i + CONCURRENCY).map(processLead));
    }

    await recordOrgRuns(admin, "agent-06-enrichment", sourcingOrgIds);
    ctx.setItemsProcessed(promoted + blocked);
    ctx.setStatus(errored > 0 && promoted + blocked === 0 ? "failure" : errored > 0 ? "partial" : "success");
    const reasonStr = Object.entries(blockedReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    ctx.setSummary(
      `Enriched ${promoted}/${leads.length} → stage=enriched · ${blocked} left at raw${reasonStr ? ` (${reasonStr})` : ""}${skipped ? ` · ${skipped} deferred (deadline)` : ""}${superseded ? ` · ${superseded} superseded` : ""}${errored ? ` · ${errored} errors` : ""}`
    );
  },
});
