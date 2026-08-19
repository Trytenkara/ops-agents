import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import {
  findDuplicateBoundLeads,
  PROMOTABLE_STAGES,
  type GuardLead,
  type GuardSupplier,
} from "@/lib/lead-dupe-guard";
import {
  getOrgAssignmentContext,
  orgAutoKey,
  spreadOwnerId,
  type AssignmentContext,
} from "@/lib/operator-assignment";
import { sortOrgsByPriority } from "@/lib/org-priority";

// Stops a lead from becoming a duplicate supplier in Tenkara.
//
// Tenkara promotes our `enriched` and `ready_for_outreach` leads into supplier
// rows hourly, and its duplicate check disables itself on exactly the shape a
// duplicate has (see lib/lead-dupe-guard.ts). We cannot change that check, so
// this agent takes the lead out of the promotable set before it runs.
//
// Parking is `ready_for_approval`, which Tenkara does not promote. That keeps
// the lead alive and editable rather than dropping it, because a wrong call
// here would silently kill a real supplier: the operator resolves the case by
// dropping the lead (a genuine duplicate) or sending it back to `enriched` (a
// false positive), both of which already exist as row actions on the leads tab.

const MAX_PARKS_PER_RUN = 60;
const LEAD_PAGE = 1000;
// Tenkara supplier counts per org are in the thousands, not the millions.
const SUPPLIER_SCAN_LIMIT = 20_000;

interface OrgRow {
  id: string;
  slug: string;
  tenkara_org_id: string | null;
  is_internal: boolean;
}

registerAgent({
  slug: "agent-20-duplicate-guard",
  displayName: "Agent 20 - Duplicate Guard",
  description:
    "Parks leads that would create a duplicate supplier in Tenkara and opens a case for the operator. Prevention only; never writes to Tenkara.",
  async run(ctx) {
    const admin = createAdminClient();

    const { data: orgRows, error: orgErr } = await admin
      .from("orgs")
      .select("id, slug, tenkara_org_id, is_internal")
      .not("tenkara_org_id", "is", null);
    if (orgErr) {
      await ctx.log(`Org pull failed: ${orgErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Org pull failed: ${orgErr.message}`);
      return;
    }
    // Real clients drain the per-run budget before internal test orgs.
    const orgs = sortOrgsByPriority((orgRows ?? []) as OrgRow[]);

    let parked = 0;
    let cased = 0;
    let errored = 0;
    let scanned = 0;
    let deferred = 0;
    const orgsNotReached: string[] = [];
    const perOrg: Record<string, number> = {};

    for (const org of orgs) {
      if (parked >= MAX_PARKS_PER_RUN) {
        orgsNotReached.push(org.slug);
        continue;
      }

      // Every promotable lead, paged. PostgREST caps a select at 1000 rows and
      // the gate we are predicting counts distinct names per host across the
      // whole set, so a truncated read gives the wrong answer, not just fewer.
      const leads: GuardLead[] = [];
      let failed = false;
      for (let from = 0; ; from += LEAD_PAGE) {
        const { data: leadRows, error: leadErr } = await admin
          .from("leads_in_flight")
          .select("id, org_id, supplier_id, supplier_name, material_id, material_name, stage, payload")
          .eq("org_id", org.id)
          .eq("status", "active")
          .in("stage", PROMOTABLE_STAGES as unknown as string[])
          .order("id", { ascending: true })
          .range(from, from + LEAD_PAGE - 1);
        if (leadErr) {
          errored++;
          failed = true;
          await ctx.log(`Lead pull failed for ${org.slug}: ${leadErr.message}`, {
            level: "error",
            step: "pull",
            data: { org: org.slug },
          });
          break;
        }
        const page = (leadRows ?? []) as GuardLead[];
        leads.push(...page);
        if (page.length < LEAD_PAGE) break;
      }
      if (failed || !leads.length) continue;
      scanned += leads.length;

      let suppliers: GuardSupplier[];
      try {
        suppliers = await tenkaraQuery<GuardSupplier>(
          `select id, name, website, coalesce(is_marketplace, false) as is_marketplace
             from suppliers
            where $1 = any(organization_ids)
              and cardinality(organization_ids) = 1
            limit ${SUPPLIER_SCAN_LIMIT}`,
          [org.tenkara_org_id]
        );
      } catch (e: any) {
        // Tenkara's pooler flaps. Without the supplier list we cannot tell a
        // duplicate from a new company, and guessing would park real leads.
        errored++;
        await ctx.log(`Tenkara supplier read failed for ${org.slug}: ${e?.message ?? e}`, {
          level: "warn",
          step: "tenkara",
          data: { org: org.slug },
        });
        continue;
      }
      if (!suppliers.length) continue;

      const verdicts = findDuplicateBoundLeads(leads, suppliers);
      if (!verdicts.length) continue;
      await ctx.log(`${org.slug}: ${verdicts.length} of ${leads.length} promotable leads would duplicate`, {
        step: "detect",
        data: { org: org.slug, flagged: verdicts.length, promotable: leads.length },
      });

      let assignCtx: AssignmentContext | null = null;
      try {
        assignCtx = await getOrgAssignmentContext(admin, org.id);
      } catch {
        assignCtx = null;
      }

      for (const v of verdicts) {
        if (parked >= MAX_PARKS_PER_RUN) {
          deferred++;
          continue;
        }
        const lead = v.lead;

        // Park the RECORD, not the material. Parking used to strand the
        // sourcing question with the record question: nobody was asked about
        // this material while an operator decided whether the company was
        // already on file. If the match is unambiguous (one existing company,
        // and we can find its supplier row), point the lead at that record now.
        // The second record still never gets created, which is the whole job of
        // this agent, but the material is attached to the company we already
        // have and the inquiry can go out against it.
        let routedTo: { id: string; name: string } | null = null;
        if (v.existingNames.length === 1 && !lead.supplier_id) {
          const target = suppliers.find(
            (s) => !s.is_marketplace && (s.name ?? "").trim().toLowerCase() === v.existingNames[0].trim().toLowerCase()
          );
          if (target?.id != null) routedTo = { id: String(target.id), name: target.name ?? v.existingNames[0] };
        }

        const { error: parkErr } = await admin
          .from("leads_in_flight")
          .update({
            stage: "ready_for_approval",
            ...(routedTo ? { supplier_id: routedTo.id } : {}),
            payload: {
              ...(lead.payload ?? {}),
              duplicate_review: {
                pending: true,
                domain: v.domain,
                existing_supplier_names: v.existingNames,
                kind: v.kind,
                reason: v.reason,
                canonical_name: v.canonicalName,
                material_routed_to: routedTo,
                parked_from_stage: lead.stage,
                parked_at: new Date().toISOString(),
                parked_by_run_id: ctx.runId,
              },
            },
          })
          .eq("id", lead.id)
          .eq("status", "active")
          // Only park a lead still in the promotable set: another agent may have
          // moved it since the read, and re-staging it would undo that.
          .in("stage", PROMOTABLE_STAGES as unknown as string[]);
        if (parkErr) {
          errored++;
          await ctx.log(`Park failed for lead ${lead.id}: ${parkErr.message}`, {
            level: "error",
            step: "park",
            data: { lead_id: lead.id },
          });
          continue;
        }
        parked++;
        perOrg[org.slug] = (perOrg[org.slug] ?? 0) + 1;

        const assignedOperator = assignCtx
          ? spreadOwnerId(
              assignCtx,
              orgAutoKey(assignCtx, { supplierName: lead.supplier_name, leadId: lead.id }),
              { nameHint: lead.supplier_name }
            )
          : null;

        const existing = v.existingNames.slice(0, 3).join(", ");
        const more = v.existingNames.length > 3 ? ` +${v.existingNames.length - 3} more` : "";
        const { error: caseErr } = await admin.from("cases").insert({
          org_id: org.id,
          type: "duplicate_supplier",
          status: "open",
          material_id: lead.material_id,
          // One line. The decision itself is two buttons on the leads page's
          // "Possible duplicates" tab, which resolves this case when used.
          recommended_action: `Possible duplicate of ${existing}${more}. ${v.reason}. Held. Decide on the Possible duplicates tab.`,
          assigned_operator: assignedOperator,
          metadata: {
            source_agent: "agent-20-duplicate-guard",
            source_run_id: ctx.runId,
            lead_id: lead.id,
            domain: v.domain,
            kind: v.kind,
            existing_supplier_names: v.existingNames,
            supplier_name: lead.supplier_name,
            material_name: lead.material_name,
            parked_from_stage: lead.stage,
          },
        });
        // The unique index makes a re-flagged lead a no-op rather than an error
        // worth counting; the lead is parked either way, which is the point.
        if (caseErr && !/duplicate key/i.test(caseErr.message)) {
          errored++;
          await ctx.log(`Case insert failed for lead ${lead.id}: ${caseErr.message}`, {
            level: "error",
            step: "case",
            data: { lead_id: lead.id },
          });
          continue;
        }
        if (!caseErr) cased++;
      }
    }

    const breakdown = Object.entries(perOrg)
      .map(([slug, n]) => `${slug} ${n}`)
      .join(", ");
    // The per-run cap is a rate limit, not a worklist limit: say out loud what
    // it left behind so a growing backlog is visible rather than looking done.
    const leftover =
      deferred || orgsNotReached.length
        ? ` Hit the ${MAX_PARKS_PER_RUN}-per-run cap: ${deferred} more flagged this pass` +
          (orgsNotReached.length ? `, and ${orgsNotReached.join(", ")} not scanned` : "") +
          `. The next run picks them up.`
        : "";
    ctx.setItemsProcessed(parked);
    ctx.setStatus(errored > 0 && parked === 0 ? "partial" : "success");
    ctx.setSummary(
      parked === 0
        ? `No duplicate-bound leads in ${scanned} promotable leads.${leftover}`
        : `Parked ${parked} duplicate-bound leads (${breakdown}), opened ${cased} cases.${leftover}`
    );
    ctx.setMetadata({
      scanned,
      parked,
      cased,
      errored,
      deferred,
      orgs_not_reached: orgsNotReached,
      per_org: perOrg,
    });
  },
});
