import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { cappedRead } from "@/lib/capped-read";
import { loadOrgStatuses, sourcingAllowed } from "@/lib/org-status";
import { loadDueOrgIds, recordOrgRuns } from "@/lib/org-tier";
import { assessMaterialRelevance, collectProductText, type RawLead } from "./enrich";
import { enrichAndStageLead } from "./run-enrich";
import { resetContactProviderBreaker } from "@/lib/contact-provider-usage";
import { seedProfilesFromLeads } from "@/lib/supplier-profiles";
import { seedQuoteProfilesFromStaged, syncQuoteProfilesFromMarketplace } from "@/lib/quote-profiles";
import { loadMarketplaceCaseDims } from "@/lib/marketplace-case-dims";
import { fillProfilesFromKnownSources } from "@/lib/supplier-profile-fill";
import { runSupplierWebFill } from "./web-fill-run";
import { resolveMaterialGradeSpecs } from "@/lib/tenkara-names";
import { loadSelfSuppliedMaterialIds } from "@/lib/self-supplied-materials";
import { getClientRequirements, dealbreakerCertNames } from "@/lib/tenkara-requirements";
import type { DealbreakerSpec } from "@/lib/dealbreaker-fit";

// v1 trim (vs. full spec):
//   - pre-outreach only. Reply-driven enrichment lands when Agent 08
//     (Email Scanner) ships.
//   - cron-style sweep of stage='raw' & status='active' leads, ordered by
//     confidence_score DESC so the most promising candidates get enriched first.
//   - cap 40 leads/run (increased from 25 for higher throughput). Secondary lanes
//     have 600s budget with no seeding/filling overhead, so 40 is achievable.
//     Primary lane will process fewer due to profile work, but total fleet
//     throughput increases significantly.
const MAX_LEADS_PER_RUN = 40;
// Per run, flip this many "parked" leads (enriched, live website, but no email —
// invisible to the raw claim) back to stage='raw' so the full contact stack
// re-runs over them (rule 4: don't give up on no-contact leads). Primary-lane
// only. Modest cap + a cooldown in the RPC keeps re-tries from starving fresh
// discovery or thrashing a genuinely-dead lead more than weekly.
//
// Held under the claim's retry allowance (0093 reserves p_cap/5 = 5 per lane, so
// 10 per pass across the two lanes). Re-queue faster than that and the retry tail
// grows every pass, which is the state 0092 left the fleet in.
const REQUEUE_PARKED_PER_RUN = 8;
// Secondary lanes skip the profile seed/fill phases, so their whole invocation is
// lead work and they can afford to finish the batch they claimed. That is where
// most of the throughput comes from, not the lane count: measured over 24h the
// single lane averaged 460s and reached only ~10 of its 25 leads, because seeding
// and filling had already eaten the wall clock ahead of it.
const LEAD_DEADLINE_MS = 230_000; // primary: what is left after seed + fill
// 650s + a batch that can now take LEAD_TIMEOUT_MS left too little of the 800s
// cap for the summary write. Lanes were finishing well inside this anyway.
const LANE_LEAD_DEADLINE_MS = 600_000; // secondary: headroom under maxDuration 800s
// Ceiling on one lead. The deadline above only guards the START of a batch, and a
// batch waits for its slowest lead, so without this any unbounded call inside
// enrichAndStageLead can run the whole invocation past the cap. Sized so a batch
// begun at the deadline still finishes with room to write the summary.
const LEAD_TIMEOUT_MS = 120_000;
// Web profile completion: suppliers per run, and the wall-clock slice it may
// take before the rest of the agent's work starts. Increased from 12 to 20 to
// handle higher lead volume and keep web-fill pace with enrichment.
const WEB_FILL_CAP = 20;
const WEB_FILL_BUDGET_MS = 150_000;
const KNOWN_FILL_BUDGET_MS = 150_000;

registerAgent({
  slug: "agent-06-enrichment",
  displayName: "Agent 06 - Data Enrichment",
  description:
    "Pre-outreach enrichment. Sweeps stage=raw leads, probes supplier website + contact email, merges Tenkara supplier metadata, then promotes to stage=enriched for human review.",
  // Discovery stages more high-confidence leads per day (3,017) than one lane can
  // attempt (1,689), so the raw queue grew without bound and the leads at the
  // confidence floor, which is every aggregator seller we split out, were never
  // reached at all. Lanes claim disjoint batches through claim_enrichment_leads.
  // Increased from 4 to 6: contact lookups are paid per lead, but discovery outpaces
  // enrichment (3,017 leads/day staged, ~400–500/day enriched at 4 lanes). 6 lanes
  // with 40 leads/batch targets ~1,600/day, enabling faster sourcing for high-volume
  // clients like Whitecat. Contact-provider quotas (Hunter, ZoomInfo) are monitored;
  // circuit breakers trip if daily limits are hit.
  lanes: 6,
  async run(ctx) {
    const admin = createAdminClient();
    // Warm lambdas keep module state across invocations, so clear any provider
    // that tripped its circuit breaker on a previous run before this one starts.
    resetContactProviderBreaker();
    const lane = Number(ctx.input?.lane ?? 1);
    // Once-per-tick work (profile seeding, profile filling, the relevance
    // backfill) belongs to the primary lane alone. None of it is partitioned, so
    // a second lane doing it would just repeat the same sweep.
    const isPrimary = lane === 1;

    // Per-org switch: only enrich leads for orgs whose sourcing_status allows
    // pool-building (active or sourcing_only). 'off' orgs are skipped entirely.
    const orgStatuses = await loadOrgStatuses(admin);
    const allSourcingOrgIds = [...orgStatuses.byOaId.entries()].filter(([, s]) => sourcingAllowed(s)).map(([id]) => id);

    // Auto-fill the Supplier/Quote Validation tabs: create an approval profile
    // row for every active supplier and staged quote so operators never have to
    // click "Seed"/"Create profile" by hand. Both seeders dedupe on existing
    // rows, so this is a cheap no-op once a supplier/quote already has a profile.
    // Runs for all sourcing orgs (not just tier-due ones) and before the raw-lead
    // early-returns, so profiles keep filling even when there's nothing left to
    // enrich. Contact basics come from lead payloads; the rest of the validation
    // fields fill from supplier replies (staged_quotes) or operator entry.
    //
    // Each run is capped (a fresh org can have thousands of un-profiled
    // suppliers; seeding them all in one invocation would blow the function
    // timeout). The remainder drains over subsequent runs since seeding skips
    // rows that already have profiles. Real/paying clients seed before internal
    // test orgs when the shared budget is scarce.
    const SUPPLIER_SEED_CAP = 200;
    // The marketplace reserve now covers a whole price ladder per lead, not one
    // headline row, and it also pays for re-syncing prices that moved. At 50 the
    // initial fan-out of an established org's backlog would take days to drain.
    const QUOTE_SEED_CAP = 300;
    const MARKETPLACE_QUOTE_RESERVE = 150;
    let supplierBudget = SUPPLIER_SEED_CAP;
    let stagedQuoteBudget = QUOTE_SEED_CAP - MARKETPLACE_QUOTE_RESERVE;
    let marketplaceQuoteBudget = MARKETPLACE_QUOTE_RESERVE;
    let seededSuppliers = 0;
    let seededQuotes = 0;
    let refreshedQuotes = 0;
    const { data: orgMeta } = await admin.from("orgs").select("id, is_internal, tenkara_org_id").in("id", allSourcingOrgIds);
    const isInternalById = new Map((orgMeta ?? []).map((o: any) => [o.id, !!o.is_internal]));
    const tenkaraOrgIdByOrg = new Map((orgMeta ?? []).map((o: any) => [o.id, o.tenkara_org_id as string | null]));
    // Empty on secondary lanes, which no-ops every seed and fill loop below.
    const seedOrder = (isPrimary ? [...allSourcingOrgIds] : []).sort(
      (a, b) => Number(isInternalById.get(a) ?? false) - Number(isInternalById.get(b) ?? false)
    );
    // Case-dims cache is org-agnostic; load once and reuse for the marketplace seed.
    const caseDimsMap = seedOrder.length ? await loadMarketplaceCaseDims(admin) : {};
    for (const orgId of seedOrder) {
      if (supplierBudget <= 0 && stagedQuoteBudget <= 0 && marketplaceQuoteBudget <= 0) break;
      try {
        if (supplierBudget > 0) {
          const n = await seedProfilesFromLeads(admin, orgId, supplierBudget);
          seededSuppliers += n;
          supplierBudget -= n;
        }
        // Reply-driven staged quotes first (negotiated, highest fidelity), then
        // fill the rest from marketplace listings we already web-fetched.
        if (stagedQuoteBudget > 0) {
          const n = await seedQuoteProfilesFromStaged(admin, orgId, stagedQuoteBudget);
          seededQuotes += n;
          stagedQuoteBudget -= n;
        }
        if (marketplaceQuoteBudget > 0) {
          const { created, updated } = await syncQuoteProfilesFromMarketplace(admin, orgId, caseDimsMap, marketplaceQuoteBudget);
          seededQuotes += created;
          refreshedQuotes += updated;
          marketplaceQuoteBudget -= created + updated;
        }
      } catch (e: any) {
        await ctx.log(`Profile seed failed for org ${orgId}: ${e?.message ?? e}`, { level: "warn", step: "seed-profiles" });
      }
    }
    if (seededSuppliers || seededQuotes || refreshedQuotes) {
      await ctx.log(`Seeded ${seededSuppliers} supplier + ${seededQuotes} quote profiles, refreshed ${refreshedQuotes} marketplace quote prices`, {
        step: "seed-profiles",
        data: { supplier_profiles: seededSuppliers, quote_profiles: seededQuotes, quote_profiles_refreshed: refreshedQuotes },
      });
    }
    const seedNote = seededSuppliers || seededQuotes || refreshedQuotes
      ? ` · seeded ${seededSuppliers} supplier + ${seededQuotes} quote profiles${refreshedQuotes ? ` · refreshed ${refreshedQuotes} quote prices` : ""}`
      : "";

    // Creating the profile row is only half the job: the validation card is
    // useless while every field in it is blank. Refill from the sources we
    // already own on every cycle (free, deterministic), then spend web calls on
    // the long tail that none of them cover.
    const tenkaraOrgIdByOa = new Map(
      (await admin.from("orgs").select("id, tenkara_org_id").in("id", allSourcingOrgIds)).data
        ?.map((o: any) => [o.id, o.tenkara_org_id as string | null]) ?? []
    );
    let filledFields = 0;
    const fillDeadline = Date.now() + KNOWN_FILL_BUDGET_MS;
    for (const orgId of seedOrder) {
      if (Date.now() >= fillDeadline) break;
      try {
        const s = await fillProfilesFromKnownSources(admin, orgId, tenkaraOrgIdByOa.get(orgId) ?? null, fillDeadline);
        filledFields += s.fieldsFilled;
        if (s.fieldsFilled) {
          await ctx.log(`Filled ${s.fieldsFilled} profile fields across ${s.profilesUpdated} suppliers`, {
            step: "fill-profiles",
            data: { org_id: orgId, ...s },
          });
        }
      } catch (e: any) {
        await ctx.log(`Profile fill failed for org ${orgId}: ${e?.message ?? e}`, { level: "warn", step: "fill-profiles" });
      }
    }

    // Web completion is paid work, so it is real clients only and hard-capped.
    // The deadline keeps it from eating the enrichment budget behind it.
    let webFilled = 0;
    const webDeadline = Date.now() + WEB_FILL_BUDGET_MS;
    let webBudget = WEB_FILL_CAP;
    for (const orgId of seedOrder.filter((id) => !isInternalById.get(id))) {
      if (webBudget <= 0 || Date.now() >= webDeadline) break;
      try {
        const s = await runSupplierWebFill(admin, orgId, webBudget, webDeadline);
        webBudget -= s.attempted;
        webFilled += s.fieldsFilled;
        if (s.attempted) {
          await ctx.log(
            `Web-filled ${s.fieldsFilled} fields over ${s.attempted} suppliers (${s.exhausted} fields not published, ${s.unreachable} sites unreachable, will retry)`,
            {
              step: "web-fill-profiles",
              data: { org_id: orgId, ...s },
            }
          );
        }
      } catch (e: any) {
        await ctx.log(`Profile web fill failed for org ${orgId}: ${e?.message ?? e}`, { level: "warn", step: "web-fill-profiles" });
      }
    }
    const fillNote = filledFields || webFilled ? ` · filled ${filledFields + webFilled} profile fields` : "";

    const sourcingOrgIds = await loadDueOrgIds(admin, "agent-06-enrichment", allSourcingOrgIds);
    if (sourcingOrgIds.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary((allSourcingOrgIds.length ? "All orgs throttled by tier, not due yet." : "No orgs are active/sourcing_only, nothing to enrich.") + seedNote + fillNote);
      return;
    }

    // Relevance backfill is a sweep over already-promoted leads, so like the
    // seeders it is primary-lane-only.
    // PERS-06: the batch drains over successive runs, which is fine, but until
    // now nothing said how deep the backfill queue still was, so a queue that
    // was not draining looked exactly like one that had finished.
    let historical: any[] = [];
    let historicalNote = "";
    let historicalError: { message: string } | null = null;
    if (isPrimary) {
      try {
        const read = await cappedRead<any>(
          admin
            .from("leads_in_flight")
            .select("id, material_name, source, payload", { count: "exact" })
            .eq("status", "active")
            .in("stage", ["enriched", "ready_for_outreach"])
            .in("source", ["importyeti", "sourceready"])
            .in("org_id", sourcingOrgIds)
            .is("payload->enrichment->material_relevance", null)
            .order("created_at", { ascending: true })
            .limit(MAX_LEADS_PER_RUN),
          MAX_LEADS_PER_RUN,
          "leads awaiting a relevance backfill"
        );
        historical = read.rows;
        if (read.remainder) historicalNote = ` · ${read.remainder} more awaiting relevance backfill`;
        await ctx.log(read.note, { step: "relevance_backfill", data: { backlog: read.total, remainder: read.remainder } });
      } catch (e: any) {
        historicalError = { message: e.message };
      }
    }
    if (historicalError) {
      await ctx.log(`Historical relevance scan failed: ${historicalError.message}`, { level: "error", step: "relevance_backfill" });
    } else {
      for (const lead of historical) {
        const payload = (lead.payload as any) ?? {};
        const productText = collectProductText(payload);
        if (!productText) continue;
        const check = assessMaterialRelevance({
          materialName: lead.material_name,
          inci: payload.inci_name ?? null,
          productText,
        });
        if (check.relevant) {
          await admin.from("leads_in_flight").update({
            payload: {
              ...payload,
              enrichment: { ...(payload.enrichment ?? {}), material_relevance: check },
            },
          }).eq("id", lead.id).eq("status", "active");
          continue;
        }
        await admin.from("leads_in_flight").update({
          stage: "terminal",
          status: "terminal",
          drop_reason: "provider_product_mismatch",
          payload: {
            ...payload,
            relevance_flag: "material_capability_unverified",
            relevance_note: check.note,
            enrichment: { ...(payload.enrichment ?? {}), material_relevance: check },
          },
        }).eq("id", lead.id).eq("status", "active").in("stage", ["enriched", "ready_for_outreach"]);
      }
    }

    // 0. RE-QUEUE parked no-email leads (primary lane only): flip a capped,
    //    cooled-down batch of enriched-but-emailless leads back to stage='raw' so
    //    the claim below re-runs the full contact stack over them. These are
    //    otherwise invisible to the claim (it only sees stage='raw'), so without
    //    this they never get another contact attempt (rule 4). Best-effort: a
    //    failure here must never block the enrichment pass.
    if (isPrimary) {
      const { data: requeued, error: requeueErr } = await admin.rpc("requeue_parked_contact_leads", {
        p_org_ids: sourcingOrgIds,
        p_cap: REQUEUE_PARKED_PER_RUN,
      });
      if (requeueErr) {
        await ctx.log(`Parked-lead re-queue failed: ${requeueErr.message}`, { level: "warn", step: "requeue_parked" });
      } else if (typeof requeued === "number" && requeued > 0) {
        await ctx.log(`Re-queued ${requeued} parked no-email leads for another contact pass`, {
          step: "requeue_parked",
          data: { count: requeued },
        });
      }
    }

    // 1. CLAIM a batch of raw leads: never-attempted first, then whatever was tried
    //    longest ago, with confidence and then age breaking ties inside each group.
    //
    //    Ordering on confidence alone deadlocked this sweep: a blocked lead stays at
    //    stage=raw and its score never moves, so once 25 of them collected at the top
    //    of a tier the same rows were re-selected every run and promotion sat at zero
    //    for days. The attempt timestamp is mutated by every attempt, so a lead
    //    physically cannot be re-selected ahead of untried work, and blocked leads
    //    come back for a retry only after the queue has cycled.
    //
    //    This is an RPC rather than a select because lanes run concurrently: the
    //    function picks and stamps in one statement (FOR UPDATE SKIP LOCKED), so no
    //    two lanes can be handed the same lead and pay for the same contact lookup
    //    twice. It returns prev_attempt_at so leads we drop at the deadline can have
    //    their stamp put back, having never actually been attempted.
    let { data: leads, error: pullErr } = await admin.rpc("claim_enrichment_leads", {
      p_org_ids: sourcingOrgIds,
      p_cap: MAX_LEADS_PER_RUN,
    });

    if (pullErr) {
      await ctx.log(`Failed to pull raw leads: ${pullErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${pullErr.message}`);
      return;
    }

    // Don't spend contact-provider credits on a material the client supplies
    // themselves. Claimed-then-skipped leads keep their fresh attempt stamp, which
    // is what we want: they go to the back of the queue instead of being re-claimed
    // every run. Fail-open on a Tenkara error.
    try {
      const selfSupplied = await loadSelfSuppliedMaterialIds();
      if (selfSupplied.size) {
        const before = (leads ?? []).length;
        leads = ((leads ?? []) as any[]).filter((l) => !(l.material_id && selfSupplied.has(l.material_id)));
        const skipped = before - leads.length;
        if (skipped) await ctx.log(`Skipped ${skipped} lead(s) on self-supplied materials`, { step: "pull" });
      }
    } catch (e: any) {
      await ctx.log(`Self-supplied lookup failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "pull" });
    }

    if (!leads || leads.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No raw leads to enrich." + seedNote + fillNote);
      return;
    }

    await ctx.log(`Enriching ${leads.length} raw leads (lane ${lane})`, {
      step: "pull",
      data: { count: leads.length, lane },
    });

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
    let leadTimeouts = 0;
    const blockedReasons: Record<string, number> = {};
    const startedAt = Date.now();

    type LeadRow = { id: string; org_id: string | null; supplier_id: string | null; supplier_name: string | null; material_name: string | null; material_id: string | null; source: string | null; payload: any; confidence_score: number | null; prev_attempt_at: string | null };

    // Resolve the client's DEALBREAKER specs once for the whole batch. Both sources
    // live in Tenkara, a different database, so this cannot be a join in the claim
    // and must not be a per-lead query either: it is two reads per batch (one for
    // every distinct material, one per distinct org) shared across 25 leads.
    //
    // Best-effort throughout. A Tenkara hiccup must not fail enrichment, so a
    // failed lookup leaves the spec null and the verdict simply isn't recorded.
    const specsByMaterial = new Map<string, DealbreakerSpec>();
    // Cert dealbreakers apply org-wide, so they still bind on a lead whose
    // material_id was never resolved (no grade spec to look up).
    const certsByOrg = new Map<string, string[]>();
    {
      const rows = leads as LeadRow[];
      const materialIds = Array.from(new Set(rows.map((r) => r.material_id).filter((v): v is string => !!v)));
      const orgIds = Array.from(new Set(rows.map((r) => r.org_id).filter((v): v is string => !!v)));

      const gradeSpecs = materialIds.length
        ? await resolveMaterialGradeSpecs(materialIds).catch(() => new Map())
        : new Map();

      for (const orgId of orgIds) {
        const tenkaraId = tenkaraOrgIdByOrg.get(orgId) ?? null;
        if (!tenkaraId) continue;
        const items = await getClientRequirements(tenkaraId).catch(() => []);
        certsByOrg.set(orgId, dealbreakerCertNames(items));
      }

      for (const row of rows) {
        if (!row.material_id) continue;
        // `required` is the dealbreaker grades comma-joined; multiple grades on one
        // material are conjunctive facets, so split them back apart.
        const required = gradeSpecs.get(row.material_id)?.required ?? null;
        const requiredGrades = required
          ? String(required).split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];
        const requiredCerts = row.org_id ? certsByOrg.get(row.org_id) ?? [] : [];
        if (!requiredGrades.length && !requiredCerts.length) continue;
        specsByMaterial.set(row.material_id, { requiredGrades, requiredCerts });
      }
      if (specsByMaterial.size) {
        await ctx.log(`Dealbreaker specs resolved for ${specsByMaterial.size} of ${materialIds.length} materials in batch`, {
          step: "dealbreakers",
          data: { materials_with_specs: specsByMaterial.size, materials_in_batch: materialIds.length },
        });
      }
    }

    function dealbreakerSpecFor(row: LeadRow): DealbreakerSpec | null {
      const byMaterial = row.material_id ? specsByMaterial.get(row.material_id) : undefined;
      if (byMaterial) return byMaterial;
      const certs = row.org_id ? certsByOrg.get(row.org_id) ?? [] : [];
      return certs.length ? { requiredGrades: [], requiredCerts: certs } : null;
    }

    async function processLead(row: LeadRow): Promise<void> {
      const lead: RawLead = {
        id: row.id,
        supplier_id: row.supplier_id,
        supplier_name: row.supplier_name,
        material_name: row.material_name,
        material_id: row.material_id,
        dealbreaker_spec: dealbreakerSpecFor(row),
        source: row.source,
        payload: row.payload ?? {},
        confidence_score: row.confidence_score,
        // Gate paid contact providers to real clients: internal test orgs get the
        // free scrape only, never the shared LeadMagic/ZoomInfo/Hunter credit pool.
        is_internal: row.org_id ? (isInternalById.get(row.org_id) ?? false) : false,
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

    // Stop waiting on a lead past LEAD_TIMEOUT_MS. The claim stamp deliberately
    // stays put: the abandoned promise may still be in flight and may still write,
    // so releasing it here could hand the same lead to a parallel lane. Stamped,
    // it simply sorts to the back of the queue and is retried on a later pass,
    // which is the never-give-up contract for a raw lead.
    async function processLeadCapped(row: LeadRow): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOutMarker = Symbol("timeout");
      try {
        const r = await Promise.race([
          processLead(row).then(() => null),
          new Promise<symbol>((resolve) => {
            timer = setTimeout(() => resolve(timedOutMarker), LEAD_TIMEOUT_MS);
          }),
        ]);
        if (r === timedOutMarker) {
          leadTimeouts++;
          await ctx.log(
            `Enrichment of ${row.supplier_name ?? "unknown supplier"} exceeded ${Math.round(LEAD_TIMEOUT_MS / 1000)}s and was abandoned (stays raw, retried on a later pass)`,
            { level: "warn", step: "lead-timeout", data: { lead_id: row.id, timeout_ms: LEAD_TIMEOUT_MS } }
          );
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const CONCURRENCY = 5;
    const DEADLINE_MS = isPrimary ? LEAD_DEADLINE_MS : LANE_LEAD_DEADLINE_MS;
    const rows = leads as LeadRow[];
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      if (Date.now() - startedAt > DEADLINE_MS) {
        const unreached = rows.slice(i);
        skipped = unreached.length;
        // Hand the claim back. Claiming stamped these as attempted so a parallel
        // lane would skip past them; we never touched them, so leaving the stamp
        // would push untried leads behind the whole queue.
        for (const r of unreached) {
          await admin
            .from("leads_in_flight")
            .update({ last_enrichment_attempt_at: r.prev_attempt_at })
            .eq("id", r.id)
            .eq("stage", "raw");
        }
        await ctx.log(`Deadline reached, released ${skipped} unattempted claims back to raw`, { step: "deadline" });
        break;
      }
      await Promise.all(rows.slice(i, i + CONCURRENCY).map(processLeadCapped));
    }

    // Only the primary lane advances the per-org tier clock. If every lane
    // recorded, a three-lane tick would look like three separate runs to the
    // throttle and pace clients faster than their tier allows.
    if (isPrimary) await recordOrgRuns(admin, "agent-06-enrichment", sourcingOrgIds);
    ctx.setItemsProcessed(promoted + blocked);
    ctx.setStatus(errored > 0 && promoted + blocked === 0 ? "failure" : errored > 0 ? "partial" : "success");
    const reasonStr = Object.entries(blockedReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    ctx.setSummary(
      `Lane ${lane}: enriched ${promoted}/${leads.length} → stage=enriched · ${blocked} left at raw${reasonStr ? ` (${reasonStr})` : ""}${skipped ? ` · ${skipped} deferred (deadline)` : ""}${leadTimeouts ? ` · ${leadTimeouts} timed out (retried later)` : ""}${superseded ? ` · ${superseded} superseded` : ""}${errored ? ` · ${errored} errors` : ""}${historicalNote}${seedNote}${fillNote}`
    );
  },
});
