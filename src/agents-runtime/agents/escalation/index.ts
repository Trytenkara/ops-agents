import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";

// v1: open a case for any lead that's been sitting at status='active' with no
// movement for STALE_DAYS. The case carries the supplier/material so an
// operator can pick it up; the lead itself is moved to status='dropped' with
// drop_reason='escalated_to_case' so it doesn't keep tripping this sweep.
//
// Stage-aware staleness thresholds: a lead at stage='ready_for_outreach' that
// has been waiting on a human to press Send for 14 days deserves a nudge,
// but a lead at stage='raw' that no one has triaged for 14 days is the same
// kind of staleness — both surface as cases here. We don't differentiate
// thresholds in v1; future iteration can.
const STALE_DAYS = 14;
const MAX_ESCALATIONS_PER_RUN = 25;

registerAgent({
  slug: "agent-07-escalation",
  displayName: "Agent 07 - Escalation",
  description:
    "Sweeps stale active leads (no movement in 14d), opens a case for the assigned operator, and drops the lead with reason=escalated_to_case.",
  async run(ctx) {
    const admin = createAdminClient();

    const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 3600 * 1000).toISOString();
    const { data: leads, error: pullErr } = await admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_id, material_id, supplier_name, material_name, stage, updated_at, payload")
      .eq("status", "active")
      .lt("updated_at", cutoff)
      .order("updated_at", { ascending: true })
      .limit(MAX_ESCALATIONS_PER_RUN);

    if (pullErr) {
      await ctx.log(`Pull failed: ${pullErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${pullErr.message}`);
      return;
    }
    if (!leads || leads.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(`No leads older than ${STALE_DAYS}d to escalate.`);
      return;
    }
    await ctx.log(`Found ${leads.length} stale leads (>${STALE_DAYS}d at status=active)`, { step: "pull" });

    // Look up operators in one round-trip.
    const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
    const opByOrg = new Map<string, string | null>();
    if (orgIds.length) {
      const { data: opRows } = await admin
        .from("org_default_operators")
        .select("org_id, primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(status)")
        .in("org_id", orgIds);
      for (const r of (opRows ?? []) as any[]) {
        const ooo = r.primary_user?.status === "out_of_office";
        opByOrg.set(r.org_id, ooo ? (r.backup_user_id ?? r.primary_user_id) : r.primary_user_id);
      }
    }

    let escalated = 0;
    let errored = 0;
    let skippedNoOrg = 0;

    for (const lead of leads) {
      if (!lead.org_id) {
        // cases.org_id is NOT NULL — we can't open a case without one.
        skippedNoOrg++;
        await ctx.log(`Lead ${lead.id} has no org_id; skipping (cases requires org)`, {
          level: "warn",
          step: "skip",
          data: { lead_id: lead.id },
        });
        continue;
      }

      const ageDays = Math.floor((Date.now() - new Date(lead.updated_at).getTime()) / (24 * 3600 * 1000));
      const recommended =
        lead.stage === "ready_for_outreach"
          ? "Operator review: outreach draft is stale, decide whether to send or drop."
          : lead.stage === "enriched"
          ? "Operator review: lead sat at enriched without outreach; revive or drop."
          : "Operator review: stale raw lead — triage or drop.";

      const assignedOperator = opByOrg.get(lead.org_id) ?? null;

      const { data: inserted, error: caseErr } = await admin
        .from("cases")
        .insert({
          org_id: lead.org_id,
          type: "other",
          status: "open",
          supplier_id: lead.supplier_id,
          material_id: lead.material_id,
          recommended_action: recommended,
          assigned_operator: assignedOperator,
          metadata: {
            source_agent: "agent-07-escalation",
            source_run_id: ctx.runId,
            lead_id: lead.id,
            stale_days: ageDays,
            stage_at_escalation: lead.stage,
            supplier_name: lead.supplier_name,
            material_name: lead.material_name,
          },
        })
        .select("id")
        .single();

      if (caseErr || !inserted) {
        errored++;
        await ctx.log(`Case insert failed for lead ${lead.id}: ${caseErr?.message}`, {
          level: "error",
          step: "case",
          data: { lead_id: lead.id },
        });
        continue;
      }

      const { error: upErr } = await admin
        .from("leads_in_flight")
        .update({
          status: "dropped",
          drop_reason: "escalated_to_case",
          payload: {
            ...(lead.payload ?? {}),
            escalation: {
              case_id: inserted.id,
              escalated_at: new Date().toISOString(),
              escalated_by_run_id: ctx.runId,
              stale_days: ageDays,
            },
          },
        })
        .eq("id", lead.id);

      if (upErr) {
        errored++;
        await ctx.log(`Lead drop failed after case ${inserted.id}: ${upErr.message}`, {
          level: "error",
          step: "drop",
          data: { lead_id: lead.id, case_id: inserted.id },
        });
        continue;
      }
      escalated++;
      await ctx.log(`Escalated ${lead.supplier_name} × ${lead.material_name} → case ${inserted.id} (${ageDays}d stale)`, {
        step: "escalated",
        data: { lead_id: lead.id, case_id: inserted.id, stale_days: ageDays },
      });
    }

    ctx.setItemsProcessed(escalated);
    ctx.setStatus(errored > 0 && escalated === 0 ? "failure" : errored > 0 ? "partial" : "success");
    ctx.setSummary(
      `Escalated ${escalated}/${leads.length} stale lead${escalated === 1 ? "" : "s"} → cases${skippedNoOrg ? ` · ${skippedNoOrg} skipped (no org)` : ""}${errored ? ` · ${errored} errors` : ""}`
    );
  },
});
