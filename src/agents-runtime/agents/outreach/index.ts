import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrgOperatorPool, resolveSupplierOperatorId, getSupplierAssignments, type OperatorRef } from "@/lib/operator-assignment";
import { classifyClient } from "../quote-revalidation/config";
import { onlyOrgNames } from "@/lib/org-scope";
import { runOutreachForSupplier, type OutreachLead } from "./run-outreach";
import { composeOutreachDraft } from "./drafter";
import { isAggregatorEmail } from "../data-enrichment/enrich";
import { suppliersWithPriorRelationship } from "@/lib/tenkara-relationships";
import { getSourcingExclusions, exclusionReason } from "@/lib/tenkara-sourcing-exclusions";
import { resolveMaterialNames } from "@/lib/tenkara-names";

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

// Phased outreach (ops flow, confirmed 2026-07-10): the FIRST email to a supplier
// leads with a small pool of materials, not the whole list — "we don't want to
// overwhelm the suppliers." The remaining materials are held (payload.phased_hold)
// and introduced into the conversation only after the supplier engages (Phase 2,
// reply loop). Pool size is small and env-overridable.
const DEFAULT_FIRST_POOL_SIZE = 3;
function envFirstPoolSize(): number {
  const v = process.env.OUTREACH_FIRST_POOL_SIZE;
  if (!v) return DEFAULT_FIRST_POOL_SIZE;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FIRST_POOL_SIZE;
}

// Compile-gate: don't draft a supplier's first email until its full material list
// is known — i.e. it has no sibling lead still being enriched (stage='raw' with no
// enrichment_blocked_reason). Bounded so a permanently-stuck raw lead (enrichment
// keeps failing without a reason) can't block the supplier's outreach forever.
const COMPILE_WAIT_MAX_DAYS = 7;

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
      .select("id, org_id, supplier_id, assigned_operator_id, supplier_name, material_id, material_name, payload, confidence_score")
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

    // Hold outreach for materials with an UNRESOLVED spelling flag, so we don't
    // draft (and later have to regenerate) wrong-spelling emails. Leads stay at
    // stage=enriched and get picked up automatically once ops applies/dismisses
    // the flag — no cron change, just a per-run skip.
    const pendingByOrg = new Map<string, Set<string>>();
    {
      const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
      if (orgIds.length) {
        const { data: pf } = await admin
          .from("material_name_flags")
          .select("org_id, wrong_name")
          .in("org_id", orgIds)
          .eq("status", "pending");
        for (const r of (pf ?? []) as any[]) {
          if (!pendingByOrg.has(r.org_id)) pendingByOrg.set(r.org_id, new Set());
          pendingByOrg.get(r.org_id)!.add((r.wrong_name as string).toLowerCase());
        }
      }
    }

    // Resolve each lead's authoritative material name from Tenkara. The name we
    // stored on the lead can be blank/stale (the bulk importer writes
    // trade_name='' on unbranded materials, which older label logic surfaced as
    // an empty name). Tenkara is the source of truth, so re-derive here and never
    // draft with a placeholder.
    let matNamesById = new Map<string, string>();
    try {
      matNamesById = await resolveMaterialNames(leads.map((l) => l.material_id).filter(Boolean) as string[]);
    } catch (e: any) {
      await ctx.log(`Material-name resolve failed: ${e?.message ?? e}`, { level: "warn", step: "material_names" });
    }

    // Compile-gate: which suppliers still have a material being enriched? We only
    // draft a supplier's first email once we have their ENTIRE list, so a supplier
    // with a sibling lead still at stage='raw' (and not terminally blocked, and not
    // stuck past the wait bound) is held this run. Batched so it's one query.
    // Keyed by `${org_id}:${supplier_id}` — a supplier's material list is
    // per-client, so a raw lead for the same supplier under a different org must
    // not hold this org's outreach.
    const compileKey = (orgId: string | null, supplierId: string | null) => `${orgId ?? ""}:${supplierId ?? ""}`;
    const suppliersStillCompiling = new Set<string>();
    {
      const batchSupplierIds = Array.from(new Set(leads.map((l) => l.supplier_id).filter(Boolean) as string[]));
      if (batchSupplierIds.length) {
        const staleCutoff = new Date(Date.now() - COMPILE_WAIT_MAX_DAYS * 86_400_000).toISOString();
        const { data: rawSibs } = await admin
          .from("leads_in_flight")
          .select("supplier_id, org_id, payload, created_at")
          .in("supplier_id", batchSupplierIds)
          .eq("stage", "raw")
          .eq("status", "active");
        for (const r of (rawSibs ?? []) as any[]) {
          if (!r.supplier_id) continue;
          if ((r.payload ?? {}).enrichment_blocked_reason) continue; // won't enrich without ops
          if (r.created_at && r.created_at < staleCutoff) continue; // stuck too long — stop waiting
          suppliersStillCompiling.add(compileKey(r.org_id, r.supplier_id));
        }
      }
    }

    const candidates: Candidate[] = [];
    const onlyOrgs = onlyOrgNames();
    const onlyOrgLabel = onlyOrgs.join(", ");
    let droppedNoContact = 0;
    let droppedNoOrg = 0;
    let droppedSkipClient = 0;
    let droppedOtherOrg = 0;
    let heldForSpelling = 0;
    let heldForMissingName = 0;
    let heldPhasedCarry = 0; // leads already held for a follow-up from a prior run

    // Suppliers with at least one material blocked this run (spelling flag /
    // missing name). We hold the WHOLE supplier so they get one complete
    // consolidated email later, never a partial now.
    const blockedSupplierKeys = new Set<string>();
    const supplierKeyForLead = (l: (typeof leads)[number]): string =>
      l.supplier_id
        ? `s:${l.supplier_id}`
        : (l.payload as any)?.supplier_contact_email
          ? `e:${String((l.payload as any).supplier_contact_email).toLowerCase()}`
          : `l:${l.id}`;

    for (const lead of leads) {
      const payload = (lead.payload ?? {}) as any;
      // Already held for a follow-up (first-pool email went out; this material is
      // queued to be introduced after the supplier engages). Not a fresh cold
      // candidate — the reply loop (Phase 2) releases it, not this sweep.
      if (payload.phased_hold) {
        heldPhasedCarry++;
        continue;
      }
      // Never draft outreach without a material name. Prefer the stored name,
      // else the authoritative Tenkara name; if neither exists the material is
      // genuinely nameless — hold the lead (stays at stage=enriched) for ops to
      // fix the material in Tenkara and re-run, rather than sending a supplier a
      // "the material" RFQ.
      const resolvedName =
        (lead.material_name && lead.material_name.trim()) ||
        (lead.material_id ? matNamesById.get(lead.material_id) ?? null : null);
      if (!resolvedName) {
        heldForMissingName++;
        blockedSupplierKeys.add(supplierKeyForLead(lead));
        continue;
      }
      lead.material_name = resolvedName; // normalize so every draft uses the real name
      const email = (payload.supplier_contact_email as string | undefined) ?? null;
      const formatValid = payload.enrichment?.email_check?.format_valid === true;
      // Never cold-email a marketplace/aggregator address (e.g. concierge@knowde.com)
      // — it reaches the platform, not the supplier. Fall through to the manual
      // channel so an operator handles it. Enrichment normally strips these, but
      // guard here too for leads enriched before that landed.
      const aggregatorEmail = isAggregatorEmail(email);
      const hasEmail = !!email && formatValid && !aggregatorEmail;
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
      if (onlyOrgs.length && !onlyOrgs.includes(org.name)) {
        droppedOtherOrg++;
        continue;
      }
      // Hold if this material has an unresolved spelling flag.
      if (lead.material_name && pendingByOrg.get(lead.org_id)?.has(lead.material_name.toLowerCase())) {
        heldForSpelling++;
        blockedSupplierKeys.add(supplierKeyForLead(lead));
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
        // Manual lead claim wins (Scout leads); then manual supplier assignment;
        // then sticky-random. Scout leads have no supplier_id — fall back to the
        // lead id so the sticky default spreads across the pool instead of all
        // landing on pool[0] (matches the Leads-tab display key). Else org primary.
        assignedOperator:
          lead.assigned_operator_id ??
          resolveSupplierOperatorId(assignmentsByOrg.get(lead.org_id) ?? new Map(), poolByOrg.get(lead.org_id) ?? [], lead.supplier_id ?? lead.id) ??
          org.primary_user_id,
      });
    }

    const emailCount = candidates.filter((c) => c.channel === "email").length;
    const manualCount = candidates.filter((c) => c.channel === "manual").length;
    await ctx.log(
      `Filtered: ${candidates.length} actionable (${emailCount} email, ${manualCount} manual-contact) · dropped ${droppedNoContact} (no contact channel), ${droppedNoOrg} (no org map), ${droppedSkipClient} (unclassified client)${onlyOrgs.length ? `, ${droppedOtherOrg} (outside ${onlyOrgLabel})` : ""}${heldForSpelling ? ` · held ${heldForSpelling} (pending spelling review)` : ""}${heldForMissingName ? ` · held ${heldForMissingName} (missing material name)` : ""}${heldPhasedCarry ? ` · skipped ${heldPhasedCarry} (held for follow-up)` : ""}`,
      { step: "filter" }
    );

    if (candidates.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(`No actionable leads after filters (no_contact=${droppedNoContact}, no_org=${droppedNoOrg}, skip_client=${droppedSkipClient}${onlyOrgs.length ? `, other_org=${droppedOtherOrg}` : ""}${heldForSpelling ? `, held_spelling=${heldForSpelling}` : ""}${heldForMissingName ? `, held_missing_name=${heldForMissingName}` : ""}).`);
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

    // 4b/5. Act. Manual leads dedupe per material against an open case. Email
    //       leads CONSOLIDATE per supplier: one email lists every material we're
    //       sourcing from that supplier, so a supplier never gets a separate
    //       mail per material.
    let staged = 0; // first-contact email drafts staged (one per supplier)
    let manualCased = 0;
    let missiveErrors = 0;
    let promoted = 0; // leads promoted to ready_for_outreach (the first pool)
    let dedupSkipped = 0;
    let heldSuppliers = 0; // suppliers held because a sibling material is blocked
    let heldCompiling = 0; // suppliers held: full material list not yet enriched
    let phasedHeld = 0; // materials held for a follow-up (not in the first pool)

    const emailCandidates = candidatesNoPrior.filter((c) => c.channel === "email");
    const manualCandidates = candidatesNoPrior.filter((c) => c.channel === "manual");

    // ---- Manual-contact cases (per material) --------------------------------
    for (const c of manualCandidates) {
      if (staged + manualCased >= maxDrafts) break;
      const { data: existing } = await admin
        .from("cases")
        .select("id")
        .eq("org_id", c.lead.org_id)
        .eq("supplier_id", c.lead.supplier_id)
        .eq("material_id", c.lead.material_id)
        .eq("type", "manual_outreach")
        .eq("status", "open")
        .maybeSingle();
      if (existing) {
        dedupSkipped++;
        continue;
      }

      const p = (c.lead.payload ?? {}) as any;
      const aggregatorEmail = p.enrichment?.aggregator_contact_email ?? null;
      const draft = await composeOutreachDraft({
        mode: c.mode,
        ghostBrand: c.ghostBrand,
        clientOrgName: c.clientOrgName,
        supplierContactName: c.contactName,
        supplierCompanyName: c.lead.supplier_name,
        materialName: c.lead.material_name?.trim() || "the material",
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
        recommended_action:
          `No direct supplier email for ${c.lead.supplier_name ?? "this supplier"}. Send the RFQ for ${c.lead.material_name?.trim() || "the material"} via their contact form / marketplace inquiry: ${c.channelUrl ?? "(see supplier site)"}` +
          (aggregatorEmail ? ` · marketplace listing shows ${aggregatorEmail} — do not cold-email the marketplace` : ""),
        assigned_operator: c.assignedOperator,
        metadata: {
          source_agent: "agent-04-outreach",
          source_run_id: ctx.runId,
          lead_id: c.lead.id,
          supplier_name: c.lead.supplier_name,
          material_name: c.lead.material_name,
          contact_url: c.channelUrl,
          aggregator_contact_email: aggregatorEmail,
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

    // ---- First-contact email drafts (per supplier, small pool) --------------
    // Phased outreach: group each supplier's actionable materials, then send ONE
    // first email leading with a small pool (ops: "don't overwhelm the supplier
    // with the whole list"). The rest are held (payload.phased_hold) for the reply
    // loop to introduce after the supplier engages.
    const firstPoolSize = envFirstPoolSize();
    const supplierKeyOf = (c: Candidate): string =>
      c.lead.supplier_id ? `s:${c.lead.supplier_id}` : `e:${(c.email ?? "").toLowerCase()}`;
    const emailBySupplier = new Map<string, Candidate[]>();
    for (const c of emailCandidates) {
      const k = supplierKeyOf(c);
      const arr = emailBySupplier.get(k) ?? [];
      arr.push(c);
      emailBySupplier.set(k, arr);
    }

    // Stamp payload.phased_hold on leads whose material isn't in the first email —
    // queued for a follow-up once the supplier engages (Phase 2, reply loop).
    const holdForFollowup = async (leadsToHold: Candidate[], poolMaterialIds: string[], draftRefId?: string) => {
      for (const c of leadsToHold) {
        // Drop any stale compile-hold — this material is now past first contact.
        const { outreach_hold, ...p } = (c.lead.payload ?? {}) as any;
        await admin
          .from("leads_in_flight")
          .update({
            payload: {
              ...p,
              phased_hold: {
                reason: "awaiting_engagement",
                first_pool_material_ids: poolMaterialIds,
                first_pool_draft_ref_id: draftRefId ?? null,
                held_at: new Date().toISOString(),
                run_id: ctx.runId,
              },
            },
          })
          .eq("id", c.lead.id);
        phasedHeld++;
      }
    };

    for (const [key, group] of emailBySupplier) {
      if (staged + manualCased >= maxDrafts) break;
      const primary = group[0];
      const supplierId = primary.lead.supplier_id;

      // Hold the WHOLE supplier if any sibling material is blocked this run
      // (spelling flag / missing name) — no half-finished first contact.
      if (blockedSupplierKeys.has(key)) {
        heldSuppliers++;
        for (const c of group) {
          const p = (c.lead.payload ?? {}) as any;
          await admin
            .from("leads_in_flight")
            .update({
              payload: { ...p, outreach_hold: { reason: "awaiting_sibling_materials", at: new Date().toISOString(), run_id: ctx.runId } },
            })
            .eq("id", c.lead.id);
        }
        continue;
      }

      // Compile-gate: don't make first contact until we have the supplier's full
      // material list — i.e. nothing of theirs is still being enriched.
      if (supplierId && suppliersStillCompiling.has(compileKey(primary.lead.org_id, supplierId))) {
        heldCompiling++;
        for (const c of group) {
          const p = (c.lead.payload ?? {}) as any;
          await admin
            .from("leads_in_flight")
            .update({
              payload: { ...p, outreach_hold: { reason: "awaiting_full_list", at: new Date().toISOString(), run_id: ctx.runId } },
            })
            .eq("id", c.lead.id);
        }
        continue;
      }

      // Already contacted? If a live draft exists for this supplier, first contact
      // already happened — these newly-enriched materials are follow-ups, so hold
      // them for the reply loop rather than opening a second cold thread.
      if (supplierId) {
        const { data: existing } = await admin
          .from("draft_references")
          .select("id")
          .eq("agent_id", tackleAgentId)
          .eq("org_id", primary.lead.org_id)
          .eq("supplier_id", supplierId)
          .in("status", ["staged", "reviewed", "sent"])
          .limit(1);
        if (existing && existing.length) {
          await holdForFollowup(group, [], existing[0].id);
          continue;
        }
      }

      // First contact. Lead with a small pool of the supplier's materials
      // (highest confidence first); hold the remainder for a follow-up. No
      // material category on the lead, so "closely related" degrades to the
      // top-N by readiness — good enough for a first touch.
      const ranked = [...group].sort(
        (a, b) =>
          (b.lead.confidence_score ?? 0) - (a.lead.confidence_score ?? 0) ||
          (a.lead.material_name ?? "").localeCompare(b.lead.material_name ?? "")
      );
      const pool = ranked.slice(0, firstPoolSize);
      const remainder = ranked.slice(firstPoolSize);
      const poolMaterialIds = pool.map((c) => c.lead.material_id).filter(Boolean) as string[];

      const p0 = (primary.lead.payload ?? {}) as any;
      const isMarketplace =
        (primary.lead as any).market_kind === "marketplace" ||
        p0.site_type === "M" ||
        p0.site_type === "MS" ||
        p0.enrichment?.tenkara_supplier?.is_marketplace === true;

      const res = await runOutreachForSupplier({
        admin,
        agentId: tackleAgentId,
        runId: ctx.runId,
        orgId: primary.lead.org_id,
        supplierId,
        supplierName: primary.lead.supplier_name,
        email: primary.email!,
        contactName: primary.contactName,
        mode: primary.mode,
        ghostBrand: primary.ghostBrand,
        clientOrgName: primary.clientOrgName,
        assignedOperator: primary.assignedOperator,
        isMarketplace,
        leads: pool.map((c) => c.lead as OutreachLead),
        log: (m, meta) => ctx.log(m, meta),
      });
      if (res.staged) {
        staged++;
        promoted += res.promoted;
        if (remainder.length) await holdForFollowup(remainder, poolMaterialIds, res.draftRefId);
      } else {
        missiveErrors++;
      }
    }

    ctx.setItemsProcessed(staged + manualCased);
    ctx.setStatus(missiveErrors > 0 && staged + manualCased === 0 ? "failure" : missiveErrors > 0 ? "partial" : "success");
    ctx.setSummary(
      `Staged ${staged} first-contact email${staged === 1 ? "" : "s"} · ${manualCased} manual-contact case${manualCased === 1 ? "" : "s"} · promoted ${promoted} to ready_for_outreach${phasedHeld ? ` · ${phasedHeld} material${phasedHeld === 1 ? "" : "s"} held for follow-up` : ""}` +
        (heldSuppliers ? ` · held ${heldSuppliers} supplier${heldSuppliers === 1 ? "" : "s"} (blocked material)` : "") +
        (heldCompiling ? ` · held ${heldCompiling} supplier${heldCompiling === 1 ? "" : "s"} (compiling full list)` : "") +
        (missiveErrors ? ` · ${missiveErrors} errors` : "") +
        (priorRelSkipped ? ` · skipped ${priorRelSkipped} existing-relationship` : "") +
        (dedupSkipped ? ` · skipped ${dedupSkipped} already-staged/cased` : "") +
        (droppedNoContact || droppedNoOrg || droppedSkipClient
          ? ` · dropped ${droppedNoContact + droppedNoOrg + droppedSkipClient} pre-filter`
          : "")
    );
  },
});
