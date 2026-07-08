import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrgOperatorPool, resolveSupplierOperatorId, getSupplierAssignments, type OperatorRef } from "@/lib/operator-assignment";
import { classifyClient } from "../quote-revalidation/config";
import { onlyOrgName } from "@/lib/org-scope";
import { runOutreachForLead } from "./run-outreach";
import { composeOutreachDraft } from "./drafter";
import { suppliersWithPriorRelationship } from "@/lib/tenkara-relationships";
import { getSourcingExclusions, exclusionReason } from "@/lib/tenkara-sourcing-exclusions";

// v1 trim (vs. full spec):
//   - pre-outreach only. Reply tracking + follow-up cadence land with Agent 08.
//   - cron-style sweep of stage='enriched' & status='active' leads, ordered by
//     completeness_score DESC so the best-known suppliers go first.
//   - cap aggressively (env-overridable). The first run is meant to be small
//     and reviewable — operators eyeball every draft in Missive before sending.
//   - deterministic template only (no LLM). Keeps voice consistent across runs
//     and avoids burning OpenAI tokens when the email content is so structured.
//
// Safety: the Missive client refuses `send: true` and `from_field` at both
// compile- and run-time. No email leaves Missive without a human pressing Send.
const DEFAULT_MAX_DRAFTS_PER_RUN = 5;

function envMaxDrafts(): number {
  const v = process.env.OUTREACH_MAX_DRAFTS_PER_RUN;
  if (!v) return DEFAULT_MAX_DRAFTS_PER_RUN;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DRAFTS_PER_RUN;
}

async function getAgentIdBySlug(admin: ReturnType<typeof createAdminClient>, slug: string): Promise<string | null> {
  const { data } = await admin.from("agents").select("id").eq("slug", slug).maybeSingle();
  return data?.id ?? null;
}

registerAgent({
  slug: "agent-04-outreach",
  displayName: "Agent 04 - Outreach",
  description:
    "Composes outreach emails for enriched leads, stages them as Missive drafts (never sends), and promotes leads to stage=ready_for_outreach.",
  async run(ctx) {
    const admin = createAdminClient();
    const maxDrafts = envMaxDrafts();

    if (!process.env.MISSIVE_API_TOKEN) {
      await ctx.log("MISSIVE_API_TOKEN not configured — cannot stage drafts", { level: "error", step: "config" });
      ctx.setStatus("failure");
      ctx.setSummary("MISSIVE_API_TOKEN missing.");
      return;
    }

    const tackleAgentId = await getAgentIdBySlug(admin, ctx.agentSlug);
    if (!tackleAgentId) {
      await ctx.log("Agent row not found by slug", { level: "error", step: "config" });
      ctx.setStatus("failure");
      ctx.setSummary("Agent row missing.");
      return;
    }

    // 1. Pull enriched leads, best completeness first.
    const { data: leads, error: pullErr } = await admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_id, supplier_name, material_id, material_name, payload, confidence_score")
      .eq("stage", "enriched")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(maxDrafts * 4); // over-fetch to allow filtering before capping

    if (pullErr) {
      await ctx.log(`Pull failed: ${pullErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${pullErr.message}`);
      return;
    }
    if (!leads || leads.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No enriched leads ready for outreach.");
      return;
    }
    await ctx.log(`Pulled ${leads.length} enriched leads (pre-filter)`, { step: "pull" });

    // 2. Resolve org info + classify in one pass. We only contact suppliers on
    //    behalf of orgs that map cleanly to a known active/ghost label.
    const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
    let orgsById = new Map<string, { id: string; name: string; tenkara_org_id: string | null; primary_user_id: string | null; backup_user_id: string | null }>();
    if (orgIds.length) {
      const { data: orgRows } = await admin
        .from("orgs")
        .select("id, name, tenkara_org_id, org_default_operators(primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(status))")
        .in("id", orgIds);
      for (const r of (orgRows ?? []) as any[]) {
        const ops = r.org_default_operators?.[0] ?? r.org_default_operators ?? null;
        const ooo = ops?.primary_user?.status === "out_of_office";
        orgsById.set(r.id, {
          id: r.id,
          name: r.name,
          tenkara_org_id: r.tenkara_org_id ?? null,
          primary_user_id: ops ? (ooo ? (ops.backup_user_id ?? ops.primary_user_id) : ops.primary_user_id) : null,
          backup_user_id: ops?.backup_user_id ?? null,
        });
      }
    }

    // Operator pool + manual assignments per org. A draft's operator is the
    // supplier's manual assignment if ops claimed it, else sticky-random.
    const poolByOrg = new Map<string, OperatorRef[]>();
    const assignmentsByOrg = new Map<string, Map<string, string>>();
    for (const oid of orgIds) {
      poolByOrg.set(oid, await getOrgOperatorPool(admin, oid).catch(() => []));
      assignmentsByOrg.set(oid, await getSupplierAssignments(admin, oid).catch(() => new Map()));
    }

    // 3. Filter to leads we can actually draft for.
    type Candidate = {
      lead: (typeof leads)[number];
      // "email" → draft a Tenkara email; "manual" → open a contact-via-form case.
      channel: "email" | "manual";
      email: string | null;
      channelUrl: string | null; // for channel="manual": the form / inquiry URL
      contactName: string | null;
      mode: "active" | "ghost";
      ghostBrand?: string;
      clientOrgName: string;
      assignedOperator: string | null;
    };

    const candidates: Candidate[] = [];
    const onlyOrg = onlyOrgName();
    let droppedNoContact = 0;
    let droppedNoOrg = 0;
    let droppedSkipClient = 0;
    let droppedOtherOrg = 0;

    for (const lead of leads) {
      const payload = (lead.payload ?? {}) as any;
      const email = (payload.supplier_contact_email as string | undefined) ?? null;
      const formatValid = payload.enrichment?.email_check?.format_valid === true;
      const hasEmail = !!email && formatValid;
      // A reachable non-email channel: a discovered contact/quote form, or the
      // supplier's own site/listing we can submit an inquiry through.
      const channelUrl =
        (payload.enrichment?.contact?.contact_url as string | undefined) ??
        (payload.supplier_website as string | undefined) ??
        (payload.source_url as string | undefined) ??
        null;
      const channel: "email" | "manual" | null = hasEmail ? "email" : channelUrl ? "manual" : null;
      if (!channel) {
        droppedNoContact++; // no email AND no contactable channel — genuinely unreachable
        continue;
      }
      if (!lead.org_id) {
        droppedNoOrg++;
        continue;
      }
      const org = orgsById.get(lead.org_id);
      if (!org) {
        droppedNoOrg++;
        continue;
      }
      if (onlyOrg && org.name !== onlyOrg) {
        droppedOtherOrg++;
        continue;
      }
      const cls = classifyClient(org.name);
      if (cls.mode === "skip") {
        droppedSkipClient++;
        continue;
      }
      candidates.push({
        lead,
        channel,
        email: hasEmail ? email : null,
        channelUrl: channel === "manual" ? channelUrl : null,
        contactName: payload.supplier_contact_name ?? null,
        mode: cls.mode,
        ghostBrand: cls.ghostBrand,
        clientOrgName: org.name,
        // Manual supplier assignment wins; else sticky-random; else org primary.
        assignedOperator:
          resolveSupplierOperatorId(assignmentsByOrg.get(lead.org_id) ?? new Map(), poolByOrg.get(lead.org_id) ?? [], lead.supplier_id) ??
          org.primary_user_id,
      });
    }

    const emailCount = candidates.filter((c) => c.channel === "email").length;
    const manualCount = candidates.filter((c) => c.channel === "manual").length;
    await ctx.log(
      `Filtered: ${candidates.length} actionable (${emailCount} email, ${manualCount} manual-contact) · dropped ${droppedNoContact} (no contact channel), ${droppedNoOrg} (no org map), ${droppedSkipClient} (unclassified client)${onlyOrg ? `, ${droppedOtherOrg} (outside ${onlyOrg})` : ""}`,
      { step: "filter" }
    );

    if (candidates.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(`No actionable leads after filters (no_contact=${droppedNoContact}, no_org=${droppedNoOrg}, skip_client=${droppedSkipClient}${onlyOrg ? `, other_org=${droppedOtherOrg}` : ""}).`);
      return;
    }

    // 4a. Drop candidates where the supplier already has a relationship with the
    //     org (any prior material_quotes row in Tenkara). An initial-RFQ email
    //     would be wrong — these need a re-engagement template, not a cold ask.
    let priorRelSkipped = 0;
    let exclusionSkipped = 0;
    const byOrg = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const arr = byOrg.get(c.lead.org_id!) ?? [];
      arr.push(c);
      byOrg.set(c.lead.org_id!, arr);
    }
    const candidatesNoPrior: Candidate[] = [];
    for (const [orgId, group] of byOrg) {
      const org = orgsById.get(orgId);
      const tenkaraOrgId = org?.tenkara_org_id ?? null;
      if (!tenkaraOrgId) {
        // No Tenkara mapping → we can't verify prior relationship. Be safe and
        // skip drafting; Agent 03 should have populated this for active orgs.
        for (const c of group) priorRelSkipped++;
        await ctx.log(`Org ${org?.name ?? orgId} has no tenkara_org_id — skipping ${group.length} candidates`, {
          level: "warn", step: "prior_relationship",
        });
        continue;
      }
      const supplierIds = group.map((c) => c.lead.supplier_id).filter(Boolean) as string[];
      let priorSet: Set<string>;
      try {
        priorSet = await suppliersWithPriorRelationship(supplierIds, tenkaraOrgId);
      } catch (e: any) {
        await ctx.log(`Prior-relationship check failed for org ${org?.name}: ${e.message}`, {
          level: "error", step: "prior_relationship",
        });
        // Fail closed — don't send cold emails to suppliers we can't verify.
        priorRelSkipped += group.length;
        continue;
      }

      // Client do-not-contact / excluded-country suppression (Tenkara client
      // settings). This is the hard gate before any email — fail closed: if we
      // can't read the client's exclusions, don't risk contacting a banned
      // supplier. Agent 03 already filters at lead creation; this catches
      // manually-added and pre-existing leads too.
      let exclusions;
      try {
        exclusions = await getSourcingExclusions(tenkaraOrgId);
      } catch (e: any) {
        await ctx.log(`Sourcing-exclusions check failed for org ${org?.name}: ${e.message}`, {
          level: "error", step: "exclusions",
        });
        exclusionSkipped += group.length;
        continue;
      }

      for (const c of group) {
        if (c.lead.supplier_id && priorSet.has(c.lead.supplier_id)) {
          priorRelSkipped++;
          continue;
        }
        const p = (c.lead.payload ?? {}) as any;
        if (exclusionReason({ name: c.lead.supplier_name, website: p.supplier_website ?? p.source_url, country: p.supplier_country }, exclusions)) {
          exclusionSkipped++;
          continue;
        }
        candidatesNoPrior.push(c);
      }
    }
    await ctx.log(
      `Prior-relationship + exclusion filter: ${candidatesNoPrior.length} kept · ${priorRelSkipped} skipped (already-known) · ${exclusionSkipped} skipped (do-not-contact / excluded country)`,
      { step: "prior_relationship" }
    );

    // 4b. Dedup: email leads against an existing staged draft; manual leads
    //     against an existing open manual_outreach case (same supplier × material).
    const cleanCandidates: Candidate[] = [];
    let dedupSkipped = 0;
    for (const c of candidatesNoPrior) {
      if (cleanCandidates.length >= maxDrafts) break;
      let existing: { id: string } | null = null;
      if (c.channel === "email") {
        const { data } = await admin
          .from("draft_references")
          .select("id")
          .eq("agent_id", tackleAgentId)
          .eq("supplier_id", c.lead.supplier_id)
          .eq("material_id", c.lead.material_id)
          .eq("status", "staged")
          .maybeSingle();
        existing = data;
      } else {
        const { data } = await admin
          .from("cases")
          .select("id")
          .eq("org_id", c.lead.org_id)
          .eq("supplier_id", c.lead.supplier_id)
          .eq("material_id", c.lead.material_id)
          .eq("type", "manual_outreach")
          .eq("status", "open")
          .maybeSingle();
        existing = data;
      }
      if (existing) {
        dedupSkipped++;
        continue;
      }
      cleanCandidates.push(c);
    }

    await ctx.log(`After dedup: ${cleanCandidates.length} actionable (skipped ${dedupSkipped} already-staged/cased)`, { step: "dedup" });

    if (cleanCandidates.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(`All ${candidates.length} candidates already have staged drafts.`);
      return;
    }

    // 5. Compose + act, serially. Email leads → staged Tenkara draft. Manual
    //    leads → a manual_outreach case with ready-to-paste RFQ text so the
    //    operator can reach out through the form/marketplace, then drop the lead.
    let staged = 0;
    let manualCased = 0;
    let missiveErrors = 0;
    let promoted = 0;

    for (const c of cleanCandidates) {
      if (c.channel === "email") {
        const res = await runOutreachForLead({
          admin,
          agentId: tackleAgentId,
          runId: ctx.runId,
          lead: c.lead,
          email: c.email!,
          contactName: c.contactName,
          mode: c.mode,
          ghostBrand: c.ghostBrand,
          clientOrgName: c.clientOrgName,
          assignedOperator: c.assignedOperator,
          log: (m, meta) => ctx.log(m, meta),
        });
        if (res.staged) {
          staged++;
          if (!res.reason) promoted++;
        } else {
          missiveErrors++;
        }
        continue;
      }

      // channel === "manual"
      const p = (c.lead.payload ?? {}) as any;
      const draft = composeOutreachDraft({
        mode: c.mode,
        ghostBrand: c.ghostBrand,
        clientOrgName: c.clientOrgName,
        supplierContactName: c.contactName,
        supplierCompanyName: c.lead.supplier_name,
        materialName: c.lead.material_name ?? "the material",
        inciName: p.inci ?? p.inci_name ?? null,
        signal: p.signal ?? null,
        isMarketplace: (c.lead as any).market_kind === "marketplace" || p.site_type === "M" || p.site_type === "MS",
      });
      const { error: caseErr } = await admin.from("cases").insert({
        org_id: c.lead.org_id,
        type: "manual_outreach",
        status: "open",
        supplier_id: c.lead.supplier_id,
        material_id: c.lead.material_id,
        recommended_action: `No public email for ${c.lead.supplier_name ?? "this supplier"}. Send the RFQ for ${c.lead.material_name ?? "the material"} via their contact form / marketplace inquiry: ${c.channelUrl ?? "(see supplier site)"}`,
        assigned_operator: c.assignedOperator,
        metadata: {
          source_agent: "agent-04-outreach",
          source_run_id: ctx.runId,
          lead_id: c.lead.id,
          supplier_name: c.lead.supplier_name,
          material_name: c.lead.material_name,
          contact_url: c.channelUrl,
          outreach_mode: c.mode,
          ghost_brand: c.ghostBrand ?? null,
          rfq_subject: draft.subject,
          rfq_body: draft.body,
        },
      });
      if (caseErr) {
        missiveErrors++;
        await ctx.log(`Manual-outreach case insert failed for ${c.lead.supplier_name}: ${caseErr.message}`, { level: "error", step: "manual_contact" });
        continue;
      }
      manualCased++;
      // Drop the lead so it isn't reprocessed (mirrors Agent 07's case handoff).
      await admin
        .from("leads_in_flight")
        .update({ status: "dropped", payload: { ...p, drop_reason: "manual_outreach_case" } })
        .eq("id", c.lead.id);
    }

    ctx.setItemsProcessed(staged + manualCased);
    ctx.setStatus(missiveErrors > 0 && staged + manualCased === 0 ? "failure" : missiveErrors > 0 ? "partial" : "success");
    ctx.setSummary(
      `Staged ${staged} email draft${staged === 1 ? "" : "s"} · ${manualCased} manual-contact case${manualCased === 1 ? "" : "s"} · promoted ${promoted} to ready_for_outreach` +
        (missiveErrors ? ` · ${missiveErrors} errors` : "") +
        (priorRelSkipped ? ` · skipped ${priorRelSkipped} existing-relationship` : "") +
        (dedupSkipped ? ` · skipped ${dedupSkipped} already-staged/cased` : "") +
        (droppedNoContact || droppedNoOrg || droppedSkipClient
          ? ` · dropped ${droppedNoContact + droppedNoOrg + droppedSkipClient} pre-filter`
          : "")
    );
  },
});
