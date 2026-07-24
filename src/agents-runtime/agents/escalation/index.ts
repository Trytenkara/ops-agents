import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage, deepLink } from "@/lib/slack";

// Escalation has two jobs:
//   1. (cases) open a case for any lead that's been sitting at status='active'
//   2. (nudge) chase ops in Slack about items surfaced by 02/03/08 that haven't
//      been actioned yet — staged drafts not sent, leads stuck at enriched.
//
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
// Gentler, earlier threshold for the nudge (vs. the 14d case threshold).
const NUDGE_STALE_DAYS = 3;

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
    const staleLeads = leads ?? [];
    // Note: we don't early-return on an empty set — the nudge pass below still
    // needs to run to chase un-actioned drafts/leads.
    await ctx.log(`Found ${staleLeads.length} stale leads (>${STALE_DAYS}d at status=active)`, { step: "pull" });

    // Look up operators in one round-trip.
    const orgIds = Array.from(new Set(staleLeads.map((l) => l.org_id).filter(Boolean) as string[]));
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

    // Dedup guard: an operator only needs one open case per supplier×material.
    // Without this, every stale lead for the same item opens another identical
    // case, so resolving one leaves a pile of siblings that look un-resolved.
    // Key on (org, supplier, material); skip keys where we can't identify the
    // item (both supplier and material null). Seed from cases already open, and
    // extend it as we create cases this run so same-run duplicates collapse too.
    const dedupKey = (orgId: string, supplierId: string | null, materialId: string | null) =>
      supplierId || materialId ? `${orgId}|${supplierId ?? ""}|${materialId ?? ""}` : null;

    const openCaseKeys = new Set<string>();
    if (orgIds.length) {
      const { data: openCases } = await admin
        .from("cases")
        .select("org_id, supplier_id, material_id")
        .in("org_id", orgIds)
        .in("status", ["open", "in_progress"]);
      for (const c of (openCases ?? []) as any[]) {
        const k = dedupKey(c.org_id, c.supplier_id, c.material_id);
        if (k) openCaseKeys.add(k);
      }
    }

    let escalated = 0;
    let errored = 0;
    let skippedNoOrg = 0;
    let deduped = 0;

    for (const lead of staleLeads) {
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

      // Skip if an open case already covers this supplier×material — just drop
      // the lead so it stops tripping the sweep, and point it at the existing
      // pile instead of opening a duplicate.
      const key = dedupKey(lead.org_id, lead.supplier_id, lead.material_id);
      if (key && openCaseKeys.has(key)) {
        const { error: dupDropErr } = await admin
          .from("leads_in_flight")
          .update({
            status: "dropped",
            drop_reason: "duplicate_open_case",
            payload: {
              ...(lead.payload ?? {}),
              escalation: {
                deduped_against_open_case: true,
                escalated_by_run_id: ctx.runId,
                stale_days: ageDays,
              },
            },
          })
          .eq("id", lead.id);
        if (dupDropErr) {
          errored++;
          await ctx.log(`Dedup drop failed for lead ${lead.id}: ${dupDropErr.message}`, {
            level: "error",
            step: "dedup",
            data: { lead_id: lead.id },
          });
        } else {
          deduped++;
          await ctx.log(`Skipped duplicate escalation for ${lead.supplier_name} × ${lead.material_name} (open case exists)`, {
            step: "dedup",
            data: { lead_id: lead.id },
          });
        }
        continue;
      }

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
      if (key) openCaseKeys.add(key);
      await ctx.log(`Escalated ${lead.supplier_name} × ${lead.material_name} → case ${inserted.id} (${ageDays}d stale)`, {
        step: "escalated",
        data: { lead_id: lead.id, case_id: inserted.id, stale_days: ageDays },
      });
    }

    // --- Nudge pass: chase un-actioned items surfaced by 02/03/08 ---------
    // Pure nudge — no DB writes, just a Slack chase. Counts per org: staged
    // drafts not yet sent, and leads parked at enriched awaiting a promote.
    const nudgeCutoff = new Date(Date.now() - NUDGE_STALE_DAYS * 24 * 3600 * 1000).toISOString();
    let nudgedOrgs = 0;
    try {
      const [{ data: staleDrafts }, { data: stuckLeads }] = await Promise.all([
        admin
          .from("draft_references")
          .select("org_id, metadata")
          .eq("status", "staged")
          .lt("created_at", nudgeCutoff)
          .limit(1000),
        admin
          .from("leads_in_flight")
          .select("org_id")
          .eq("status", "active")
          .eq("stage", "enriched")
          .lt("updated_at", nudgeCutoff)
          .limit(1000),
      ]);

      type Counts = { drafts: number; replies: number; promote: number };
      const byOrg = new Map<string, Counts>();
      const bump = (orgId: string | null, k: keyof Counts) => {
        if (!orgId) return;
        const c = byOrg.get(orgId) ?? { drafts: 0, replies: 0, promote: 0 };
        c[k]++;
        byOrg.set(orgId, c);
      };
      for (const d of (staleDrafts ?? []) as any[]) {
        bump(d.org_id, (d.metadata as any)?.draft_kind === "inbound_reply" ? "replies" : "drafts");
      }
      for (const l of (stuckLeads ?? []) as any[]) bump(l.org_id, "promote");

      if (byOrg.size > 0) {
        const { data: orgRows } = await admin.from("orgs").select("id, slug, name").in("id", Array.from(byOrg.keys()));
        const orgById = new Map((orgRows ?? []).map((o: any) => [o.id, o]));
        const lines: string[] = [];
        for (const [orgId, c] of byOrg) {
          const org = orgById.get(orgId);
          if (!org) continue;
          const bits = [
            c.drafts ? `${c.drafts} draft${c.drafts === 1 ? "" : "s"} to send` : null,
            c.replies ? `${c.replies} reply draft${c.replies === 1 ? "" : "s"} to send` : null,
            c.promote ? `${c.promote} lead${c.promote === 1 ? "" : "s"} to promote` : null,
          ].filter(Boolean);
          if (!bits.length) continue;
          lines.push(`• <${deepLink(`/work/orgs/${org.slug}`)}|${org.name}>: ${bits.join(", ")}`);
          nudgedOrgs++;
        }
        if (lines.length && process.env.SLACK_BOT_TOKEN) {
          await postSlackMessage({
            text: `*Action pending* — items waiting on ops for >${NUDGE_STALE_DAYS}d:\n${lines.join("\n")}`,
          });
          await ctx.log(`Posted nudge for ${nudgedOrgs} org(s)`, { step: "nudge" });
        }
      }
    } catch (e: any) {
      await ctx.log(`Nudge pass failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "nudge" });
    }

    ctx.setItemsProcessed(escalated);
    ctx.setStatus(errored > 0 && escalated === 0 ? "failure" : errored > 0 ? "partial" : "success");
    ctx.setSummary(
      `Escalated ${escalated}/${staleLeads.length} stale lead${escalated === 1 ? "" : "s"} → cases${deduped ? ` · ${deduped} deduped (open case exists)` : ""}${nudgedOrgs ? ` · nudged ${nudgedOrgs} org(s)` : ""}${skippedNoOrg ? ` · ${skippedNoOrg} skipped (no org)` : ""}${errored ? ` · ${errored} errors` : ""}`
    );
  },
});
