import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrgOperatorPool, resolveSupplierOperatorId, getSupplierAssignments, type OperatorRef } from "@/lib/operator-assignment";
import { classifyClient } from "../quote-revalidation/config";
import { loadOrgStatuses, outreachAllowed } from "@/lib/org-status";
import { compileWaitMs } from "@/lib/agent-timing";
import { loadOrgTimingMap, filterDueOrgIds, recordOrgRuns } from "@/lib/org-tier";
import { runOutreachForSupplier, type OutreachLead } from "./run-outreach";
import { isAggregatorEmail, isAggregatorDomain } from "../data-enrichment/enrich";
import { suppliersWithPriorRelationship } from "@/lib/tenkara-relationships";
import { getSourcingExclusions, exclusionReason } from "@/lib/tenkara-sourcing-exclusions";
import { resolveMaterialNames } from "@/lib/tenkara-names";
import { randomUUID } from "crypto";

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
// The wait is resolved per-org (see lib/agent-timing.ts): compressed only for the
// Sierra test org, prod default (7 days) for every other org.

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
    const retryRequestId = typeof ctx.input?.retryRequestId === "string" ? ctx.input.retryRequestId : null;
    const maxDrafts = retryRequestId ? 1 : envMaxDrafts();

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

    // 1. Pull enriched leads, best completeness first — but ONLY from orgs that
    //    are online for outreach (sourcing_status = 'active'). Filtering by org
    //    status *here*, before the cap, is what makes "pause" actually mean "out
    //    of the queue": a paused org's stranded enriched leads must never occupy
    //    the draft window and shove a live client past it. Previously the org
    //    filter ran only in the candidate loop below — after this newest-first
    //    cap — so a paused org (e.g. Aurora) with fresher leftover leads starved
    //    live clients entirely. Real clients (is_internal=false) are fetched
    //    before internal test orgs so a high-volume test org can't bury them.
    const orgStatuses = await loadOrgStatuses(admin);
    const { data: orgInternalRows } = await admin.from("orgs").select("id, is_internal");
    const isInternalById = new Map<string, boolean>((orgInternalRows ?? []).map((o: any) => [o.id, !!o.is_internal]));
    const eligibleOrgIds = [...orgStatuses.byOaId.entries()]
      .filter(([, s]) => outreachAllowed(s))
      .map(([id]) => id);
    const realOrgIds = eligibleOrgIds.filter((id) => !isInternalById.get(id));
    const internalOrgIds = eligibleOrgIds.filter((id) => isInternalById.get(id));

    const leadCols =
      "id, org_id, supplier_id, assigned_operator_id, supplier_name, material_id, material_name, payload, confidence_score, outreach_approved_at";
    const fetchEnriched = (ids: string[], limit: number) => {
      if (!ids.length || limit <= 0) return Promise.resolve({ data: [] as any[], error: null as any });
      let query = admin
        .from("leads_in_flight")
        .select(leadCols)
        .eq("stage", "enriched")
        .eq("status", "active")
        .in("org_id", ids)
        // Phase-2 holds are skipped below anyway, but they cluster at the recent
        // end of this created_at DESC window and were consuming most of the
        // fetch limit every run, starving the cold leads behind them.
        .is("payload->phased_hold", null);
      if (retryRequestId) query = query.eq("payload->outreach_retry->>request_id", retryRequestId);
      else query = query.is("payload->outreach_retry", null);
      return query.order("created_at", { ascending: false }).limit(retryRequestId ? 1000 : limit);
    };

    const cap = maxDrafts * 4; // over-fetch to allow filtering before capping
    const realRes = await fetchEnriched(realOrgIds, cap);
    if (realRes.error) {
      await ctx.log(`Pull failed: ${realRes.error.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${realRes.error.message}`);
      return;
    }
    let leads = realRes.data ?? [];
    if (leads.length < cap) {
      const fillRes = await fetchEnriched(internalOrgIds, cap - leads.length);
      if (fillRes.error) {
        await ctx.log(`Internal-org pull failed (non-fatal): ${fillRes.error.message}`, { level: "warn", step: "pull" });
      } else {
        leads = leads.concat(fillRes.data ?? []);
      }
    }
    if (!leads.length) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No enriched leads ready for outreach (online orgs).");
      return;
    }
    await ctx.log(
      `Pulled ${leads.length} enriched leads (pre-filter) · eligible orgs: real=${realOrgIds.length} internal=${internalOrgIds.length}`,
      { step: "pull" }
    );

    // 2. Resolve org info + classify in one pass. We only contact suppliers on
    //    behalf of orgs that map cleanly to a known active/ghost label.
    const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
    let orgsById = new Map<string, { id: string; name: string; tenkara_org_id: string | null; tenkara_email_account_id: string | null; primary_user_id: string | null; backup_user_id: string | null }>();
    if (orgIds.length) {
      const { data: orgRows } = await admin
        .from("orgs")
        .select("id, name, tenkara_org_id, tenkara_email_account_id, org_default_operators(primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(status))")
        .in("id", orgIds);
      for (const r of (orgRows ?? []) as any[]) {
        const ops = r.org_default_operators?.[0] ?? r.org_default_operators ?? null;
        const ooo = ops?.primary_user?.status === "out_of_office";
        orgsById.set(r.id, {
          id: r.id,
          name: r.name,
          tenkara_org_id: r.tenkara_org_id ?? null,
          tenkara_email_account_id: r.tenkara_email_account_id ?? null,
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
      channel: "email";
      email: string | null;
      channelUrl: string | null;
      contactName: string | null;
      additionalContacts: { email: string; name: string | null }[];
      mode: "active" | "ghost";
      ghostBrand?: string;
      clientOrgName: string;
      emailAccountId?: string | null;
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
        const nowMs = Date.now();
        const { data: rawSibs } = await admin
          .from("leads_in_flight")
          .select("supplier_id, org_id, payload, created_at")
          .in("supplier_id", batchSupplierIds)
          .eq("stage", "raw")
          .eq("status", "active");
        for (const r of (rawSibs ?? []) as any[]) {
          if (!r.supplier_id) continue;
          if ((r.payload ?? {}).enrichment_blocked_reason) continue; // won't enrich without ops
          // Per-org wait: compressed only for the Sierra test org, prod default elsewhere.
          const staleCutoff = new Date(nowMs - compileWaitMs(r.org_id)).toISOString();
          if (r.created_at && r.created_at < staleCutoff) continue; // stuck too long — stop waiting
          suppliersStillCompiling.add(compileKey(r.org_id, r.supplier_id));
        }
      }
    }

    const marketplaceFor = (lead: any, payload: any, channelUrl: string | null) => {
      const host = channelUrl ? channelUrl.replace(/^https?:\/\//, "").split("/")[0].toLowerCase().replace(/^www\./, "") : null;
      return isAggregatorDomain(host) || payload.site_type === "M" || payload.site_type === "MS" || payload.site_type === "A" || payload.supplier_role === "Marketplace" || payload.supplier_role === "Reseller" || payload.enrichment?.tenkara_supplier?.is_marketplace === true;
    };
    const approvalFingerprint = (email: string, payload: any) => [email, payload?.supplier_website ?? payload?.source_url ?? "", JSON.stringify(payload?.enrichment?.marketplace_trust ?? {})].join("|");
    const candidates: Candidate[] = [];
    // Per-org switch (orgStatuses loaded above at the fetch): outreach only acts
    // for orgs whose sourcing_status is 'active'. The fetch already excludes
    // paused orgs; this is a belt-and-suspenders guard in the candidate loop.
    let filteredNoContact = 0; // non-marketplace, no cold-emailable contact → filtered out
    let marketplacePricingLeft = 0; // marketplace, no email → left active for price-pull
    let droppedNoOrg = 0;
    let droppedSkipClient = 0;
    let droppedPausedOrg = 0;
    let heldForSpelling = 0;
    let heldForMissingName = 0;
    let heldPhasedCarry = 0; // leads already held for a follow-up from a prior run
    let heldForMarketplaceReview = 0;

    // Suppliers with at least one material blocked this run (spelling flag /
    // missing name). We hold the WHOLE supplier so they get one complete
    // consolidated email later, never a partial now.
    //
    // Unify keys early: if a lead without supplier_id shares an email with one
    // that has it, use the supplier_id key so blocked-supplier tracking is
    // consistent with the outreach grouping below (prevents partial blocks).
    const earlyEmailToSupplierId = new Map<string, string>();
    for (const l of leads) {
      const em = String((l.payload as any)?.supplier_contact_email ?? "").trim().toLowerCase();
      if (l.supplier_id && em) earlyEmailToSupplierId.set(em, l.supplier_id);
    }
    const blockedSupplierKeys = new Set<string>();
    const supplierKeyForLead = (l: (typeof leads)[number]): string => {
      if (l.supplier_id) return `s:${l.supplier_id}`;
      const em = String((l.payload as any)?.supplier_contact_email ?? "").trim().toLowerCase();
      if (em) {
        const siblingId = earlyEmailToSupplierId.get(em);
        if (siblingId) return `s:${siblingId}`;
        return `e:${em}`;
      }
      return `l:${l.id}`;
    };

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
      // supplier's own site/listing.
      const channelUrl =
        (payload.enrichment?.contact?.contact_url as string | undefined) ??
        (payload.supplier_website as string | undefined) ??
        (payload.source_url as string | undefined) ??
        null;

      // Resolve org + client policy before any channel decision, so a paused or
      // unmapped client never has leads filtered out from under it.
      if (!lead.org_id) {
        droppedNoOrg++;
        continue;
      }
      const org = orgsById.get(lead.org_id);
      if (!org) {
        droppedNoOrg++;
        continue;
      }
      if (!outreachAllowed(orgStatuses.byOaId.get(lead.org_id) ?? "off")) {
        droppedPausedOrg++;
        continue;
      }
      // Hold if this material has an unresolved spelling flag.
      if (lead.material_name && pendingByOrg.get(lead.org_id)?.has(lead.material_name.toLowerCase())) {
        heldForSpelling++;
        blockedSupplierKeys.add(supplierKeyForLead(lead));
        continue;
      }
      // A Control-Room-configured inbox id makes this a self-serve active client:
      // send from that inbox, bypassing the hardcoded ACTIVE/SKIP brand lists.
      const configuredInboxId = org.tenkara_email_account_id ?? null;
      const cls = configuredInboxId ? { mode: "active" as const, ghostBrand: undefined } : classifyClient(org.name);
      if (cls.mode === "skip") {
        droppedSkipClient++;
        continue;
      }

      // No cold-emailable address. Marketplaces stay in the pipeline so price-pull
      // (Agent 05 / browserbase) can quote them; if pricing can't be pulled the
      // lead is flagged there, never filtered. Everything else is filtered out as
      // "no contact recovered" — we no longer open manual-outreach cases here.
      if (!hasEmail) {
        const isMarketplace = marketplaceFor(lead, payload, channelUrl);
        if (isMarketplace) {
          marketplacePricingLeft++;
          continue;
        }
        await admin
          .from("leads_in_flight")
          .update({ status: "dropped", drop_reason: "no_contact_recovered", payload: { ...payload, drop_reason: "no_contact_recovered" } })
          .eq("id", lead.id);
        filteredNoContact++;
        continue;
      }

      const isMarketplace = marketplaceFor(lead, payload, channelUrl);
      const emailCheck = payload.enrichment?.email_check;
      const ownedContact = payload.contact_owned_verified === true || (
        emailCheck?.domain_matches_website === true && emailCheck?.is_aggregator_domain !== true
      );
      const lowTrust = payload.enrichment?.marketplace_trust?.is_low_trust_marketplace === true;
      const currentFingerprint = approvalFingerprint(email ?? "", payload);
      const approvedFingerprint = payload.marketplace_outreach_review?.approval_fingerprint;
      const approvalCurrent = !!(lead as any).outreach_approved_at && approvedFingerprint === currentFingerprint;
      if (isMarketplace && (lowTrust || !ownedContact) && !approvalCurrent) {
        const { error: holdError } = await admin
          .from("leads_in_flight")
          .update({ stage: "ready_for_approval", outreach_approved_at: null, outreach_approved_by: null, payload: { ...payload, marketplace_outreach_review: { ...(payload.marketplace_outreach_review ?? {}), pending: true, held_at: new Date().toISOString(), reason: lowTrust ? "low_trust_marketplace" : "contact_ownership_unverified" } } })
          .eq("id", lead.id)
          .eq("status", "active")
          .eq("stage", "enriched");
        if (!holdError) {
          heldForMarketplaceReview++;
          blockedSupplierKeys.add(supplierKeyForLead(lead));
        }
        continue;
      }

      candidates.push({
        lead,
        channel: "email",
        email,
        channelUrl: null,
        contactName: payload.supplier_contact_name ?? null,
        additionalContacts: Array.isArray(payload.additional_contacts)
          ? (payload.additional_contacts as any[])
              .map((c) => ({ email: String(c?.email ?? "").trim().toLowerCase(), name: (c?.name ?? null) as string | null }))
              .filter((c) => c.email)
          : [],
        mode: cls.mode,
        ghostBrand: cls.ghostBrand,
        clientOrgName: org.name,
        emailAccountId: configuredInboxId,
        // Manual lead claim wins (Scout leads); then manual supplier assignment;
        // then sticky-random. Scout leads have no supplier_id — key the sticky
        // default on the EMAIL consolidation key (matching supplierKeyOf below) so
        // every material row of one supplier collapses to ONE operator, consistent
        // with the single consolidated thread we actually send. Fall back to lead
        // id only when there's no email (manual-contact leads). Else org primary.
        assignedOperator:
          lead.assigned_operator_id ??
          resolveSupplierOperatorId(
            assignmentsByOrg.get(lead.org_id) ?? new Map(),
            poolByOrg.get(lead.org_id) ?? [],
            lead.supplier_id ?? (hasEmail && email ? `e:${email.toLowerCase()}` : lead.id)
          ) ??
          org.primary_user_id,
      });
    }

    const emailCount = candidates.filter((c) => c.channel === "email").length;
    await ctx.log(
      `Filtered: ${candidates.length} actionable (${emailCount} email) · filtered out ${filteredNoContact} (no contact recovered), left ${marketplacePricingLeft} marketplace for price-pull, ${droppedNoOrg} (no org map), ${droppedSkipClient} (unclassified client)${droppedPausedOrg ? `, ${droppedPausedOrg} (org not active)` : ""}${heldForSpelling ? ` · held ${heldForSpelling} (pending spelling review)` : ""}${heldForMissingName ? ` · held ${heldForMissingName} (missing material name)` : ""}${heldPhasedCarry ? ` · skipped ${heldPhasedCarry} (held for follow-up)` : ""}${heldForMarketplaceReview ? ` · held ${heldForMarketplaceReview} (marketplace outreach review)` : ""}`,
      { step: "filter" }
    );

    if (candidates.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(`No actionable leads after filters (no_contact=${filteredNoContact}, marketplace_pricing=${marketplacePricingLeft}, no_org=${droppedNoOrg}, skip_client=${droppedSkipClient}${droppedPausedOrg ? `, paused_org=${droppedPausedOrg}` : ""}${heldForSpelling ? `, held_spelling=${heldForSpelling}` : ""}${heldForMissingName ? `, held_missing_name=${heldForMissingName}` : ""}).`);
      return;
    }

    // 4a. Drop candidates where the supplier already has a relationship with the
    //     org (any prior material_quotes row in Tenkara). An initial-RFQ email
    //     would be wrong — these need a re-engagement template, not a cold ask.
    let priorRelSkipped = 0;
    let exclusionSkipped = 0;
    let equipmentSkipped = 0;

    // Supplier names that signal an equipment / machinery / packaging-hardware
    // company. These companies deal with chemicals or food ingredients as input
    // to their process but do NOT sell the material itself. Suppress outreach so
    // ops can verify before contacting; a human can clear the suppression flag.
    const EQUIPMENT_SUPPLIER_NAME_RE =
      /\b(?:pump(?:s|ing)?|valve(?:s)?|filtration?|filter(?:ing)?|machinery|heat[- ]?transfer|heat[- ]?exchanger|centrifug(?:al|e|er)?|separator(?:s)?|granulat(?:or|ion)?|dryer(?:s)?|drying[- ]equip|evaporat(?:or|ion)?|conveyor(?:s)?|blower(?:s)?|agitat(?:or|ion)?|packaging[- ](?:machine|machinery|integration)|can[- ]manufactur|bottle[- ]manufactur|electric[- ]light(?:ing)?|luminaire(?:s)?|solvent[- ]extract(?:ion)?|extraction[- ]equip|spray[- ](?:dry|machine))\b/i;
    const byOrg = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const arr = byOrg.get(c.lead.org_id!) ?? [];
      arr.push(c);
      byOrg.set(c.lead.org_id!, arr);
    }
    // Pre-load tier timing for all orgs in this batch.
    const outreachOrgIds04 = [...byOrg.keys()];
    const timingMap04 = await loadOrgTimingMap(admin, "agent-04-outreach", outreachOrgIds04);
    const dueOrgIds04 = new Set(filterDueOrgIds(outreachOrgIds04, timingMap04, "agent-04-outreach"));

    const candidatesNoPrior: Candidate[] = [];
    // Post-enrichment removals to persist on the lead so the "Removed / filtered
    // out" view can explain why a lead never got outreach. Cleared markers are
    // for leads that were suppressed before but are now eligible again.
    const suppressionUpdates: { id: string; payload: any }[] = [];
    for (const [orgId, group] of byOrg) {
      if (!retryRequestId && !dueOrgIds04.has(orgId)) {
        await ctx.log(`Org ${orgsById.get(orgId)?.name ?? orgId} throttled by tier — skipping ${group.length} candidate(s)`, { step: "tier_throttle" });
        continue;
      }
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
        const p = (c.lead.payload ?? {}) as any;
        const suppress = (reason: string) =>
          suppressionUpdates.push({ id: c.lead.id, payload: { ...p, outreach_suppressed: { reason, at: new Date().toISOString(), run_id: ctx.runId } } });
        if (c.lead.supplier_id && priorSet.has(c.lead.supplier_id)) {
          priorRelSkipped++;
          suppress("prior_relationship");
          continue;
        }
        const exReason = exclusionReason({ name: c.lead.supplier_name, website: p.supplier_website ?? p.source_url, country: p.supplier_country }, exclusions);
        if (exReason) {
          exclusionSkipped++;
          suppress(exReason);
          continue;
        }
        // Equipment / machinery / packaging-hardware suppliers: companies that use
        // the material as input to their manufacturing process but don't sell it.
        // Suppress and let ops verify rather than cold-emailing a pump manufacturer
        // for chemical supply.
        if (c.lead.supplier_name && EQUIPMENT_SUPPLIER_NAME_RE.test(c.lead.supplier_name)) {
          equipmentSkipped++;
          suppress("equipment_supplier");
          continue;
        }
        // Eligible now — clear any stale suppression marker from a prior run.
        if (p.outreach_suppressed) {
          const { outreach_suppressed, ...rest } = p;
          suppressionUpdates.push({ id: c.lead.id, payload: rest });
        }
        candidatesNoPrior.push(c);
      }
    }
    // Persist suppression/clear markers (metadata only — does not change status
    // or who gets emailed). Chunked to stay within the function budget.
    for (let i = 0; i < suppressionUpdates.length; i += 25) {
      await Promise.all(
        suppressionUpdates.slice(i, i + 25).map((u) =>
          admin.from("leads_in_flight").update({ payload: u.payload }).eq("id", u.id)
        )
      );
    }
    await ctx.log(
      `Prior-relationship + exclusion filter: ${candidatesNoPrior.length} kept · ${priorRelSkipped} skipped (already-known) · ${exclusionSkipped} skipped (do-not-contact / excluded country)${equipmentSkipped ? ` · ${equipmentSkipped} skipped (equipment/machinery supplier)` : ""}`,
      { step: "prior_relationship" }
    );

    // 4b/5. Act. Manual leads dedupe per material against an open case. Email
    //       leads CONSOLIDATE per supplier: one email lists every material we're
    //       sourcing from that supplier, so a supplier never gets a separate
    //       mail per material.
    let staged = 0; // first-contact email drafts staged (one per supplier)
    let missiveErrors = 0;
    let promoted = 0; // leads promoted to ready_for_outreach (the first pool)
    let heldSuppliers = 0; // suppliers held because a sibling material is blocked
    let heldCompiling = 0; // suppliers held: full material list not yet enriched
    let phasedHeld = 0; // materials held for a follow-up (not in the first pool)

    const emailCandidates = candidatesNoPrior.filter((c) => c.channel === "email");
    const aliasByOrgEmail = new Map<string, { threadId: string; draftRefId: string | null }>();
    if (orgIds.length) {
      const { data: aliases } = await admin
        .from("supplier_email_aliases")
        .select("org_id, email, thread_id, draft_ref_id")
        .in("org_id", orgIds);
      // An alias means "a thread with this supplier already exists", which shelves
      // the lead for the reply loop. Nothing prunes the table when a draft dies,
      // so a blocked/discarded draft used to shelve that supplier FOREVER waiting
      // on an email that was never sent (128 blocked drafts left 219 such ghosts
      // on 2026-08-03). Only honour an alias whose draft is still live. An alias
      // we cannot resolve is kept: re-cold-emailing a supplier we did contact is
      // worse than holding one we didn't.
      const refIds = [...new Set((aliases ?? []).map((a: any) => a.draft_ref_id).filter(Boolean))];
      const liveRefIds = new Set<string>();
      if (refIds.length) {
        const { data: liveDrafts } = await admin
          .from("draft_references")
          .select("id")
          .in("id", refIds)
          .in("status", ["staged", "reviewed", "sent", "linked"]);
        for (const d of liveDrafts ?? []) liveRefIds.add(d.id);
      }
      let staleAliases = 0;
      for (const alias of aliases ?? []) {
        if (alias.draft_ref_id && !liveRefIds.has(alias.draft_ref_id)) {
          staleAliases++;
          continue;
        }
        aliasByOrgEmail.set(`${alias.org_id}:${alias.email}`, { threadId: alias.thread_id, draftRefId: alias.draft_ref_id });
      }
      if (staleAliases) {
        await ctx.log(`Ignored ${staleAliases} supplier alias(es) whose draft is no longer live`, { step: "alias" });
      }
    }

    // ---- First-contact email drafts (per supplier, small pool) --------------
    // Phased outreach: group each supplier's actionable materials, then send ONE
    // first email leading with a small pool (ops: "don't overwhelm the supplier
    // with the whole list"). The rest are held (payload.phased_hold) for the reply
    // loop to introduce after the supplier engages.
    const firstPoolSize = envFirstPoolSize();

    // Unify grouping keys: when a scout lead (no supplier_id) shares an email
    // with a graph/IY lead (has supplier_id), join the supplier_id group. This
    // prevents the same real supplier from landing in two groups and getting two
    // separate cold emails.
    const emailToSupplierId = new Map<string, string>();
    for (const c of emailCandidates) {
      if (c.lead.supplier_id && c.email) {
        emailToSupplierId.set(c.email.toLowerCase(), c.lead.supplier_id);
      }
    }
    const supplierKeyOf = (c: Candidate): string => {
      if (c.lead.supplier_id) return `s:${c.lead.supplier_id}`;
      const siblingId = c.email ? emailToSupplierId.get(c.email.toLowerCase()) : null;
      if (siblingId) return `s:${siblingId}`;
      return `e:${(c.email ?? "").toLowerCase()}`;
    };

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
      if (staged >= maxDrafts) break;
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

      // Already contacted? If a live draft exists for this supplier from ANY
      // agent (not just Agent 04 — Agent 02 revalidation also opens threads),
      // first contact already happened. Hold for the reply loop rather than
      // opening a second cold thread. Match on supplier_id first, then fall back
      // to email/domain match (catches cross-source duplicates where a scout lead
      // has supplier_id: null but the same email as an existing graph-lead draft).
      {
        const alias = group
          .map((candidate) => candidate.email ? aliasByOrgEmail.get(`${candidate.lead.org_id}:${candidate.email.toLowerCase()}`) : null)
          .find(Boolean);
        if (alias) {
          await holdForFollowup(group, [], alias.draftRefId ?? undefined);
          continue;
        }
        const FREE_DOMAINS = new Set([
          "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
          "icloud.com", "me.com", "protonmail.com", "proton.me", "live.com",
        ]);
        let existing: any[] = [];
        if (supplierId) {
          const { data } = await admin
            .from("draft_references")
            .select("id")
            .eq("org_id", primary.lead.org_id)
            .in("status", ["staged", "reviewed", "sent", "linked"])
            .eq("supplier_id", supplierId)
            .limit(1);
          existing = data ?? [];
        }
        if (!existing.length && primary.email) {
          const emailAddr = primary.email;
          const domain = emailAddr.split("@")[1]?.toLowerCase();
          let q = admin
            .from("draft_references")
            .select("id")
            .eq("org_id", primary.lead.org_id)
            .in("status", ["staged", "reviewed", "sent", "linked"])
            .limit(1);
          if (domain && !FREE_DOMAINS.has(domain)) {
            q = q.or(`metadata->>supplier_contact_email.ilike.${emailAddr},metadata->>supplier_contact_email.ilike.%@${domain}`);
          } else {
            q = q.ilike("metadata->>supplier_contact_email", emailAddr);
          }
          const { data } = await q;
          existing = data ?? [];
        }
        if (existing.length) {
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
      const isMarketplace = marketplaceFor(primary.lead, p0, primary.channelUrl ?? p0.supplier_website ?? p0.source_url ?? null);

      // Multi-contact CC: reach every distinct contact for this supplier on the
      // ONE thread (To: primary, CC: the rest) for better reply odds. Union the
      // group's other primary emails + each lead's enriched additional_contacts;
      // drop the To: address and any contact already attached to a thread (an
      // existing alias — already reached, and reserving it would fail the RPC).
      const primaryEmail = primary.email!.toLowerCase();
      const ccMap = new Map<string, string | null>();
      for (const candidate of group) {
        if (candidate.email && candidate.email.toLowerCase() !== primaryEmail) {
          ccMap.set(candidate.email.toLowerCase(), candidate.contactName ?? null);
        }
        for (const ac of candidate.additionalContacts) {
          if (ac.email !== primaryEmail && !ccMap.has(ac.email)) ccMap.set(ac.email, ac.name);
        }
      }
      for (const address of Array.from(ccMap.keys())) {
        if (aliasByOrgEmail.get(`${primary.lead.org_id}:${address}`)) ccMap.delete(address);
      }
      const totalCap = Number(process.env.OUTREACH_MAX_CONTACTS_PER_SUPPLIER ?? 0);
      let ccContacts = Array.from(ccMap.entries()).map(([email, name]) => ({ email, name }));
      if (totalCap > 0) ccContacts = ccContacts.slice(0, Math.max(0, totalCap - 1));

      const reservationId = randomUUID();
      // Reserve the To: address AND every CC so no other thread cold-emails them;
      // on success they all attach to this thread as aliases.
      const groupEmails = Array.from(new Set([primaryEmail, ...ccContacts.map((c) => c.email)]));
      const { data: reserved, error: reserveError } = await admin.rpc("reserve_supplier_emails", {
        p_org_id: primary.lead.org_id,
        p_emails: groupEmails,
        p_reservation_id: reservationId,
      });
      if (reserveError || reserved !== true) {
        await admin.rpc("release_supplier_email_reservation", { p_org_id: primary.lead.org_id, p_reservation_id: reservationId });
        const claimedAlias = groupEmails.map((address) => aliasByOrgEmail.get(`${primary.lead.org_id}:${address}`)).find(Boolean);
        await holdForFollowup(group, [], claimedAlias?.draftRefId ?? undefined);
        continue;
      }

      const res = await runOutreachForSupplier({
        admin,
        agentId: tackleAgentId,
        runId: ctx.runId,
        orgId: primary.lead.org_id,
        supplierId,
        supplierName: primary.lead.supplier_name,
        email: primary.email!,
        contactName: primary.contactName,
        ccContacts,
        mode: primary.mode,
        ghostBrand: primary.ghostBrand,
        clientOrgName: primary.clientOrgName,
        emailAccountId: primary.emailAccountId,
        assignedOperator: primary.assignedOperator,
        isMarketplace,
        leads: pool.map((c) => c.lead as OutreachLead),
        log: (m, meta) => ctx.log(m, meta),
      });
      if (res.staged) {
        await admin.from("supplier_email_aliases").update({
          thread_id: res.conversationId ?? null,
          draft_ref_id: res.draftRefId ?? null,
          supplier_id: supplierId,
          supplier_name: primary.lead.supplier_name,
          claim_status: "attached",
          reservation_id: null,
        }).eq("reservation_id", reservationId).eq("claim_status", "reserved");
        staged++;
        promoted += res.promoted;
        if (retryRequestId) {
          await admin.rpc("clear_outreach_retry", { p_request_id: retryRequestId });
        }
        if (remainder.length) await holdForFollowup(remainder, poolMaterialIds, res.draftRefId);
      } else {
        await admin.rpc("release_supplier_email_reservation", { p_org_id: primary.lead.org_id, p_reservation_id: reservationId });
        missiveErrors++;
      }
    }

    await recordOrgRuns(admin, "agent-04-outreach", [...dueOrgIds04]);
    ctx.setItemsProcessed(staged);
    ctx.setStatus(missiveErrors > 0 && staged === 0 ? "failure" : missiveErrors > 0 ? "partial" : "success");
    ctx.setSummary(
      `Staged ${staged} first-contact email${staged === 1 ? "" : "s"} · promoted ${promoted} to ready_for_outreach${phasedHeld ? ` · ${phasedHeld} material${phasedHeld === 1 ? "" : "s"} held for follow-up` : ""}` +
        (heldSuppliers ? ` · held ${heldSuppliers} supplier${heldSuppliers === 1 ? "" : "s"} (blocked material)` : "") +
        (heldCompiling ? ` · held ${heldCompiling} supplier${heldCompiling === 1 ? "" : "s"} (compiling full list)` : "") +
        (missiveErrors ? ` · ${missiveErrors} errors` : "") +
        (priorRelSkipped ? ` · skipped ${priorRelSkipped} existing-relationship` : "") +
        (equipmentSkipped ? ` · skipped ${equipmentSkipped} equipment-supplier` : "") +
        (marketplacePricingLeft ? ` · left ${marketplacePricingLeft} marketplace for price-pull` : "") +
        (filteredNoContact || droppedNoOrg || droppedSkipClient
          ? ` · filtered ${filteredNoContact + droppedNoOrg + droppedSkipClient} pre-outreach`
          : "")
    );
  },
});
