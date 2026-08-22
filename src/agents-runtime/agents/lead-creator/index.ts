import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { queryRecentMaterials, queryMaterialsByIds, queryMaterialsForOrgs, queryMaterialNamesAndGrades, findCandidatesForMaterial, existingQuotesForMaterials, type CandidateSupplier, type MaterialRow } from "./sql";
import { scoutSuppliersForMaterial, scoreScoutConfidence, describeScoutConfidence, scoutCompleteness, type ScoutSupplier } from "./scout";
import { toCsv } from "@/lib/csv";
import { getSourcingExclusions, exclusionReason, normalizeCompanyName, type SourcingExclusions } from "@/lib/tenkara-sourcing-exclusions";
import { isAggregatorDomain } from "../data-enrichment/enrich";
import { isAggregatorHost } from "@/lib/aggregator-hosts";
import { getNoteDerivedCountryExclusions } from "@/lib/client-sourcing-rules";
import { uploadCsvAndSign } from "@/lib/storage";
import { onlyOrgNames } from "@/lib/org-scope";
import { normalizeStatus, sourcingAllowed } from "@/lib/org-status";
import { flagMaterialNames, correctName } from "@/lib/material-name-flags";
import { flagDuplicateMaterials, type MergeMaterial } from "@/lib/material-merge-flags";
import { materialLabel } from "@/lib/material-label";
import { loadSelfSuppliedMaterials, selfSuppliedUnavailable } from "@/lib/self-supplied-materials";
import {
  sourceReadyEnabled,
  sourceReadyUnlockEnabled,
  runSourceReadyDiscovery,
  SourceReadyUnavailableError,
} from "./sourceready";
import { importYetiEnabled, runImportYetiDiscovery, ImportYetiUnavailableError } from "./importyeti";
import { runDbReuse } from "./reuse";
import { getMaterialAliases } from "@/lib/material-aliases";
import { advanceDryPass, passOutcome } from "@/lib/dry-pass";
import { classifyFailure } from "@/lib/retry-verdict";
import { loadDueOrgIds, recordOrgRuns } from "@/lib/org-tier";

const EMPTY_OVERRIDES = new Map<string, string>();

// Discovery sometimes returns a directory / data-provider profile page (e.g. a
// Bloomberg, Volza, or beBee company URL) as the "website". Storing that as
// supplier_website makes enrichment domain-search the platform and pull the
// platform's OWN staff as the supplier's contacts. Drop such URLs at ingest so
// enrichment falls back to name-based lookup instead.
function cleanSupplierWebsite(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = hostOf(url);
  return host && isAggregatorDomain(host) ? null : url;
}

// SourceReady discovery runs in-process (bounded per material per run): calls
// supplier_search_v3 over the MCP endpoint and stages source='sourceready'
// leads inline. Inert unless SOURCEREADY_MCP_URL + SOURCEREADY_MCP_TOKEN are set.
const SOURCEREADY_MAX_MATERIALS_PER_RUN = envInt("SOURCEREADY_MAX_MATERIALS_PER_RUN", 25);
// One-pass model (2026-08-11): no pagination. Increased from 25 to 100.
const SOURCEREADY_PAGE_SIZE = envInt("SOURCEREADY_PAGE_SIZE", 100);
const IMPORTYETI_PAGE_SIZE = envInt("IMPORTYETI_PAGE_SIZE", 10);
// Seed only, for materials with no cursor yet: where the old count-derived
// paging would have been, so they resume mid-corpus instead of restarting.
const pageFor = (count: number, size: number) => Math.floor(Math.max(0, count) / Math.max(1, size)) + 1;

// Pagination cursor for the SourceReady / ImportYeti discovery fires.
//
// The page to request CANNOT be derived from the ingested lead count. Ingestion
// is lossy — host/name dedup, aggregator-platform filtering, the customs
// relevance filter and the dead-URL probe drop 30-45% of a returned page — so
// floor(count/size)+1 sticks one step short of the stride and re-requests the
// SAME page forever, making the deeper corpus unreachable. Measured 2026-08-04:
// Cetearyl Alcohol had ingested 54 active leads of a 100-supplier page 1, so it
// re-fired page 1 on every pass while page 2 held 92 suppliers we had never
// seen. ImportYeti was worse — its yield per material (1-44) never reaches a
// stride of 50, so every material fleet-wide was pinned to page 1.
//
// So the cursor is explicit: advance exactly one page per fire regardless of how
// much of the previous page survived ingestion. Wrap back to page 1 only after
// DISCOVERY_MAX_DRY_PAGES consecutive pages land nothing new — that means the
// corpus is exhausted, and wrapping (rather than stopping) lets genuinely new
// listings get picked up on a later pass.
const DISCOVERY_MIN_NEW_PER_PAGE = envInt("DISCOVERY_MIN_NEW_PER_PAGE", 2);
const DISCOVERY_MAX_DRY_PAGES = envInt("DISCOVERY_MAX_DRY_PAGES", 3);
const PAGE_CURSOR_KEY = (source: string, materialId: string) => `discovery_page:${source}:${materialId}`;
const SCOUT_RETRY_KEY = (materialId: string) => `scout_retry_passes:${materialId}`;
const SOURCEREADY_SEARCHED_KEY = (materialId: string) => `sourceready_searched:${materialId}`;
// How many passes that return nothing before a material stops being re-queried
// against SourceReady lives in DRY_PASS_LIMITS with every other dry-pass bound.
// One empty answer is not evidence the market is empty.
const SOURCEREADY_TERM_KEY = (materialId: string) => `sourceready_term:${materialId}`;

// Starvation bypass. A material under this many leads is not "sourced" yet, and
// the per-org tier interval (15 min high_frequency, 2h normal) must not be what keeps
// it waiting — the org's tier is about steady-state cadence, not about a material
// still climbing to a usable supplier count. So an org holding a starved material
// whose own per-material backoff has already elapsed skips the tier interval.
//
// Deliberately NOT MIN_LEADS_PER_MATERIAL: that is set to 100000 in prod, i.e.
// "never consider anything finished", so reusing it would mean no org is ever
// throttled and every 1-min tick would run a full Tenkara sweep.
//
// The verdict is published by the backlog sweep rather than recomputed here,
// because the throttle decision happens before any lead count is known and the
// sweep costs a Tenkara round-trip. next_at is the earliest moment a starved
// material actually becomes workable, so a permanently-thin material cannot hold
// the bypass open and spin the sweep every minute for no work.
const STARVATION_FLOOR = envInt("LEAD_CREATOR_STARVATION_FLOOR", 100);
const STARVED_ORGS_KEY = "starved_orgs";
type StarvedOrgs = Record<string, { starved: number; next_at: string | null }>;
type PageCursor = { page: number; count: number; dry: number };

function advancePageCursor(
  cursor: PageCursor | undefined,
  curCount: number,
  countKnown: boolean,
  size: number
): PageCursor {
  // First fire for this material: request the seed page ITSELF, don't advance
  // past it. Advancing here skipped page 1 on every brand-new material (seed is
  // 1 at count 0), so its first two fires asked for pages 2 and 3 of a corpus
  // whose only page was 1 — the commonest reason a new material plateaus at
  // whatever the scout alone returned.
  if (!cursor) return { page: pageFor(curCount, size), count: curCount, dry: 0 };
  // Growth is only meaningful when this run actually counted leads (a targeted
  // single-material run skips the bulk count).
  let dry = cursor.dry ?? 0;
  if (countKnown) {
    dry = curCount - cursor.count >= DISCOVERY_MIN_NEW_PER_PAGE ? 0 : dry + 1;
  }
  if (dry >= DISCOVERY_MAX_DRY_PAGES) return { page: 1, count: curCount, dry: 0 };
  return { page: cursor.page + 1, count: curCount, dry };
}

// A page the source answered with ZERO rows means the corpus ends at or before
// it, so the next page cannot hold anything either — advancing walks further
// into guaranteed-empty space (ImportYeti's stride of 10 exhausts a niche
// material in one page). Restart at page 1 and count the fire as dry.
function cursorAfterEmptyPage(requested: PageCursor, curCount: number): PageCursor {
  return { page: 1, count: curCount, dry: requested.dry + 1 };
}
// ImportYeti discovery runs in-process (bounded per material per run): pulls
// US-customs suppliers and stages source='importyeti' leads inline. Inert
// unless IMPORTYETI_API_KEY is set.
const IMPORTYETI_MAX_MATERIALS_PER_RUN = envInt("IMPORTYETI_MAX_MATERIALS_PER_RUN", 25);

// v1 trims (vs. full spec):
//   - existing-DB only mode. BrowserBase external discovery is gated on
//     BROWSERBASE_API_KEY; absent → we log and skip step 1b cleanly.
//   - cap 50 new leads per run.
//   - lookback window defaults to 4h but reads `last successful run` from
//     agent_runs so a missed cron doesn't drop materials.
// Override via env (LEAD_CREATOR_LOOKBACK_HOURS) for ops backfills or first-run
// testing — when set, takes precedence over the "since last successful run"
// logic. Production cron stays at the 4h cadence the spec asks for.
const DEFAULT_LOOKBACK_HOURS = 4;
const MAX_NEW_LEADS_PER_RUN = 300;  // expansive runs: up to ~100 scout leads/material across marketplace + non-marketplace, plus graph leads. Real work-per-run is bounded by DRIVE_BUDGET_MS (scout call count), so this is a flood-guard, not the throttle.

// Richness floor / breadth target: a material is considered "needs sourcing"
// until it has this many active leads. This is Sam's minimum-suppliers-per-
// material goal (breadth over depth — "find everyone"), not a stop-at number:
// a material keeps getting re-scouted every backoff window until it reaches the
// floor OR the market is genuinely exhausted (re-scouts exclude known hosts, so
// each pass only adds NEW suppliers and naturally tapers off). Beyond the
// recency window, every run also pulls materials below the floor (0 leads =
// never sourced, or under-sourced) so nothing is stranded — a self-draining
// work queue. Re-scouting an under-floor material is throttled per material by
// RESCOUT_BACKOFF (a marker in agent_state) so an expensive scout can't be
// re-run every tick on a material that simply has few suppliers to find.
const MIN_LEADS_PER_MATERIAL = envInt("LEAD_CREATOR_MIN_LEADS_PER_MATERIAL", 100);
const RESCOUT_BACKOFF_MS = envInt("LEAD_CREATOR_RESCOUT_BACKOFF_HOURS", 12) * 3600 * 1000;
const BACKLOG_ATTEMPT_KEY = (materialId: string) => `resource_attempt:${materialId}`;

// Diminishing-returns autopause. With the richness floor raised high (keep
// sourcing to maximum), a material would otherwise be re-scouted every backoff
// window forever — burning web-search + MCP calls long after its sources are
// exhausted. So we track, in the same attempt marker, the lead count at each
// attempt and a "dry streak": consecutive backoff cycles where the material grew
// by fewer than DISCOVERY_MIN_NEW_PER_CYCLE leads (across ALL sources, so this
// also sees out-of-band SourceReady/ImportYeti leads that landed since). After
// DISCOVERY_DRY_STREAK_LIMIT dry cycles the material is "saturated" and drops
// from the normal backoff to SATURATED_BACKOFF (a weekly re-check, not a
// permanent stop — a market can grow, and a manual marker clear resumes it).
const DISCOVERY_MIN_NEW_PER_CYCLE = envInt("DISCOVERY_MIN_NEW_PER_CYCLE", 5);
const DISCOVERY_DRY_STREAK_LIMIT = envInt("DISCOVERY_DRY_STREAK_LIMIT", 3);
const SATURATED_BACKOFF_MS = envInt("DISCOVERY_SATURATED_BACKOFF_HOURS", 168) * 3600 * 1000;

function envInt(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function envBool(name: string, dflt: boolean): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (!v) return dflt;
  return !["0", "false", "no", "off"].includes(v);
}

// DB reuse: restage suppliers already discovered for a same-named sibling material (zero paid calls).
const DB_REUSE_ENABLED = envBool("LEAD_CREATOR_DB_REUSE_ENABLED", true);
// DB reuse: at most this many reused leads staged per material per run.
const DB_REUSE_MAX_PER_MATERIAL = envInt("LEAD_CREATOR_DB_REUSE_MAX_PER_MATERIAL", 50);
// Demand gate: always keep discovering while a material holds fewer active leads than this.
const DEMAND_GATE_FLOOR = envInt("LEAD_CREATOR_DEMAND_GATE_FLOOR", 100);
// Demand gate: lookback window for counting recently-consumed (promoted) leads.
const DEMAND_WINDOW_DAYS = envInt("LEAD_CREATOR_DEMAND_WINDOW_DAYS", 7);
// Demand gate: promotions inside the window that prove outreach is still consuming this material.
const DEMAND_MIN_CONSUMED = envInt("LEAD_CREATOR_DEMAND_MIN_CONSUMED", 5);
// Saturated internal-org materials are fully parked (real clients keep the weekly re-check).
const INTERNAL_PARK_ON_SATURATION = envBool("LEAD_CREATOR_INTERNAL_PARK_ON_SATURATION", true);
// Cap on internal-org materials picked from the backlog per run; real clients fill first.
const INTERNAL_MAX_PER_RUN = envInt("LEAD_CREATOR_INTERNAL_MAX_PER_RUN", 50);

function envOverrideLookbackHours(): number | null {
  const v = process.env.LEAD_CREATOR_LOOKBACK_HOURS;
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Confidence model (deterministic, no LLM in v1):
//   quoted_same_material → 0.90 + 0.01 per extra quote (capped 0.98)
//   catalog_match        → 0.70 + 0.01 per extra catalog hit (capped 0.85)
//   quoted_similar_inci  → 0.60 + 0.01 per extra quote (capped 0.78)
//   quoted_similar_name  → 0.55 + 0.01 per extra quote (capped 0.70)
function scoreCandidate(c: CandidateSupplier): number {
  const base = {
    quoted_same_material: 0.90,
    catalog_match: 0.70,
    quoted_similar_inci: 0.60,
    quoted_similar_name: 0.55,
  }[c.signal];
  const cap = {
    quoted_same_material: 0.98,
    catalog_match: 0.85,
    quoted_similar_inci: 0.78,
    quoted_similar_name: 0.70,
  }[c.signal];
  return Math.min(cap, base + 0.01 * Math.max(0, (c.signal_count ?? 1) - 1));
}

// Human-readable rationale for the confidence_score above, stored on the lead so
// operators (and the CSV) can see *why* a lead scored what it did.
const SIGNAL_REASON: Record<CandidateSupplier["signal"], string> = {
  quoted_same_material: "previously quoted this exact material",
  catalog_match: "material appears in their catalog",
  quoted_similar_inci: "previously quoted a material with a similar INCI",
  quoted_similar_name: "previously quoted a similarly-named material",
};

// Relevance tier: "Confirmed" = supplier is verified to handle the exact target
// material. "Potential" = adjacent/similar supplier, not confirmed for this material.
const SIGNAL_RELEVANCE: Record<CandidateSupplier["signal"], "Confirmed" | "Potential"> = {
  quoted_same_material: "Confirmed",
  catalog_match: "Confirmed",
  quoted_similar_inci: "Potential",
  quoted_similar_name: "Potential",
};
function describeCandidateConfidence(c: CandidateSupplier): string {
  const n = c.signal_count ?? 1;
  const seen = n > 1 ? ` (seen ${n}×)` : "";
  return `${SIGNAL_REASON[c.signal] ?? c.signal}${seen}`;
}

function sourceFromSignal(signal: CandidateSupplier["signal"]): "existing_db" | "marketplace" {
  // All graph signals come from Tenkara prod — the existing supplier graph.
  return signal === "catalog_match" ? "marketplace" : "existing_db";
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
}

registerAgent({
  slug: "agent-03-lead-creator",
  displayName: "Agent 03 - Lead Creator",
  description:
    "Cron-driven scout. For each newly-added Tenkara material, surfaces candidate suppliers from the existing supplier graph (quote history + uploaded catalogs) into leads_in_flight @ stage='raw' for human enrichment review.",
  async run(ctx) {
    const admin = createAdminClient();

    // Agent 03 scouts + stages raw leads only. Enrichment (06) and outreach (04)
    // run as their own scheduled, isolated invocations — each agent gets its own
    // 300s budget via the cron dispatcher, so a long scout can't starve them.
    // Budget-guard the scout loop so a backlog of new materials still fits 300s.
    // This is checked BETWEEN materials, so it must leave room for one more full
    // scout call (SCOUT_CALL_TIMEOUT_MS ≈ 120s) plus overhead before the 300s
    // maxDuration: 150s + 120s + margin < 300s. A higher budget let a material
    // start late and overrun, getting the whole function hard-killed.
    // Scout calls run 200-600s each (marketplace is slowest). With a 800s route
    // timeout, a 650s budget safely lands one material per run. Two materials
    // risks the timeout and banks nothing if either call overruns.
    const DRIVE_BUDGET_MS = 650_000;
    const driveStart = Date.now();
    const elapsedMs = () => Date.now() - driveStart;

    // 1. Determine lookback window: prefer last successful run; fallback to 4h.
    const { data: lastRun } = await admin
      .from("agent_runs")
      .select("run_started_at")
      .eq("agent_id", ctx.agentId)
      .eq("status", "success")
      .neq("id", ctx.runId) // ignore the current still-running row
      .order("run_started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const override = envOverrideLookbackHours();
    const since = override
      ? new Date(Date.now() - override * 3600 * 1000)
      : lastRun?.run_started_at
      ? new Date(lastRun.run_started_at)
      : new Date(Date.now() - DEFAULT_LOOKBACK_HOURS * 3600 * 1000);
    await ctx.log(
      `Pulling materials added since ${since.toISOString()} (${override ? `env override ${override}h` : lastRun ? "since last success" : `default ${DEFAULT_LOOKBACK_HOURS}h`})`,
      { step: "query" }
    );

    // On-demand: a dashboard trigger can target one material (ignores the recency
    // window and forces a re-scout even if it already has leads).
    const onlyMaterialId = (ctx.input?.materialId as string | undefined) || null;

    // 2. Pull materials from Tenkara prod (one targeted material, or the window).
    let materials: MaterialRow[];
    try {
      materials = onlyMaterialId
        ? await queryMaterialsByIds([onlyMaterialId])
        : await queryRecentMaterials(since.toISOString());
    } catch (e: any) {
      await ctx.log(`Tenkara materials query failed: ${e.message}`, { level: "error", step: "query" });
      ctx.setStatus("failure");
      ctx.setSummary(`Failed at Tenkara materials query: ${e.message}`);
      return;
    }
    if (onlyMaterialId) await ctx.log(`Targeted single-material run: ${onlyMaterialId} (${materials.length} found)`, { step: "query" });
    await ctx.log(`${materials.length} materials in window`, { step: "query", data: { count: materials.length } });

    if (onlyMaterialId && materials.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("Targeted material has no rows in Tenkara.");
      return;
    }
    // An empty recency window is NOT terminal — the backlog queue (3b-iii) may
    // still surface under-sourced materials. Final empty-check is after the merge.

    // 3. (removed) lead_scanner_mirror dedup. The table was to be written by
    //    Agent 11's human-acknowledgement step, which was never built, so it has
    //    always held 0 rows and the guard never once fired. Its real work is done
    //    by 3d (material×supplier id) and 3e (material×supplier name) below.

    // 3b. Build Tenkara→OA org map (orgs.tenkara_org_id is the join key).
    //     Cached for the run so we make one round-trip total.
    const { data: orgRows } = await admin.from("orgs").select("id, tenkara_org_id, name, sourcing_status, is_internal");
    const tenkaraOrgToOaOrg = new Map<string, string>();
    const isInternalByOaId = new Map<string, boolean>();
    // Discovery is allowed for orgs whose sourcing_status is 'active' or 'sourcing_only'
    // (see lib/org-status.ts). ONLY_ORG, if still set, is an AND-override during rollout.
    const sourcingTenkaraOrgIds = new Set<string>();
    const sourcingNames: string[] = [];
    const only = new Set(onlyOrgNames());
    for (const r of (orgRows ?? []) as { id: string; tenkara_org_id: string | null; name: string; sourcing_status: string | null; is_internal: boolean | null }[]) {
      if (!r.tenkara_org_id) continue;
      tenkaraOrgToOaOrg.set(r.tenkara_org_id, r.id);
      isInternalByOaId.set(r.id, !!r.is_internal);
      let status = normalizeStatus(r.sourcing_status);
      if (only.size && !only.has(r.name)) status = "off";
      if (sourcingAllowed(status)) {
        sourcingTenkaraOrgIds.add(r.tenkara_org_id);
        sourcingNames.push(r.name);
      }
    }
    // Unmapped orgs count as real: fail open toward serving, never toward parking.
    const isInternalMat = (m: MaterialRow): boolean => {
      const oaId = m.tenkara_org_id ? tenkaraOrgToOaOrg.get(m.tenkara_org_id) : null;
      return oaId ? !!isInternalByOaId.get(oaId) : false;
    };
    // Apply per-org tier throttle — only process orgs whose interval has elapsed.
    const eligibleOaIds03 = [...sourcingTenkaraOrgIds].map((tid) => tenkaraOrgToOaOrg.get(tid)!).filter(Boolean);
    const dueOaIds03 = new Set(await loadDueOrgIds(admin, "agent-03-lead-creator", eligibleOaIds03));
    // Starvation bypass: an org with a below-floor material that is already past
    // its per-material backoff is due regardless of its tier interval.
    let bypassed03 = 0;
    try {
      const { data: starvedRow } = await admin
        .from("agent_state")
        .select("value")
        .eq("agent_id", ctx.agentId)
        .eq("key", STARVED_ORGS_KEY)
        .maybeSingle();
      const starved = ((starvedRow?.value as any)?.orgs ?? {}) as StarvedOrgs;
      for (const oaId of eligibleOaIds03) {
        if (dueOaIds03.has(oaId)) continue;
        const s = starved[oaId];
        if (!s?.starved) continue;
        const nextAt = s.next_at ? Date.parse(s.next_at) : 0;
        if (Number.isFinite(nextAt) && nextAt > Date.now()) continue;
        dueOaIds03.add(oaId);
        bypassed03++;
      }
    } catch (e: any) {
      await ctx.log(`Starvation bypass lookup failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "org_map" });
    }
    for (const tenkaraId of [...sourcingTenkaraOrgIds]) {
      const oaId = tenkaraOrgToOaOrg.get(tenkaraId);
      if (oaId && !dueOaIds03.has(oaId)) sourcingTenkaraOrgIds.delete(tenkaraId);
    }
    const throttled03 = eligibleOaIds03.length - dueOaIds03.size;
    await ctx.log(
      `Loaded ${tenkaraOrgToOaOrg.size} tenkara→OA org mappings · sourcing ${sourcingTenkaraOrgIds.size} org(s): ${sourcingNames.join(", ") || "none"}` +
        (throttled03 ? ` · ${throttled03} throttled (tier interval not elapsed)` : "") +
        (bypassed03 ? ` · ${bypassed03} un-throttled (starved material below ${STARVATION_FLOOR} leads)` : ""),
      { step: "org_map" }
    );

    // 3b-iii. Backlog queue — the durable guarantee that every material gets rich
    //         leads. Beyond the recency window, pull materials for our orgs that
    //         are still below the richness floor (0 leads = never sourced, or
    //         < MIN_LEADS_PER_MATERIAL) and merge them in. Nothing is stranded no
    //         matter the batch size or when it was added, with no window
    //         dependency. Re-scouting an under-floor material is throttled per
    //         material by a backoff marker so an expensive scout isn't re-run
    //         every tick on a material that simply has few suppliers to find.
    const underservedIds = new Set<string>();
    const existingHostsByMaterial = new Map<string, Set<string>>();
    // Per-source active lead counts per material, used to page the SourceReady /
    // ImportYeti discovery fires deeper on each pass (page = count/size + 1) so
    // repeated runs walk past the first page instead of re-fetching the same top
    // results. Populated from the same bulk fetch that computes the backlog floor.
    const srLeadCount = new Map<string, number>();
    const iyLeadCount = new Map<string, number>();
    // Total active leads per material (function-scoped so the saturation marker
    // write, deep in the per-material loop, can compare current vs last-attempt count).
    const leadCount = new Map<string, number>();
    // Leads promoted to ready_for_outreach/ready_for_approval inside the demand
    // window, per material: recent consumption keeps discovery open past the floor.
    const consumedRecent = new Map<string, number>();
    // Saturated internal-org materials parked this run (Feature: real clients first).
    let internalParked = 0;
    // Saturation state loaded from the attempt markers: consecutive dry cycles and
    // the lead count recorded at the last attempt, per material.
    const dryStreak = new Map<string, number>();
    const lastAttemptCount = new Map<string, number>();
    // Discovery page cursors, keyed `${source}:${materialId}`. Loaded
    // unconditionally — a targeted single-material run must page deeper too,
    // otherwise every manual re-run re-fetches page 1.
    const pageCursors = new Map<string, PageCursor>();
    for (let from = 0; ; from += 1000) {
      const { data: rows } = await admin
        .from("agent_state")
        .select("key, value")
        .eq("agent_id", ctx.agentId)
        .like("key", "discovery_page:%")
        .range(from, from + 999);
      const batch = (rows ?? []) as { key: string; value: any }[];
      for (const r of batch) {
        const page = Number(r.value?.page);
        if (!Number.isFinite(page) || page < 1) continue;
        pageCursors.set(r.key.slice("discovery_page:".length), {
          page,
          count: Number(r.value?.count) || 0,
          dry: Number(r.value?.dry) || 0,
        });
      }
      if (batch.length < 1000) break;
    }
    // The SourceReady search term that last returned suppliers, per material.
    // Each term tried is a billed search, so this turns the alias fan-out into
    // a single call for any material we have already resolved once.
    const sourceReadyTerms = new Map<string, string>();
    for (let from = 0; ; from += 1000) {
      const { data: rows } = await admin
        .from("agent_state")
        .select("key, value")
        .eq("agent_id", ctx.agentId)
        .like("key", "sourceready_term:%")
        .range(from, from + 999);
      const batch = (rows ?? []) as { key: string; value: any }[];
      for (const r of batch) {
        const term = typeof r.value?.term === "string" ? r.value.term : null;
        if (term) sourceReadyTerms.set(r.key.slice("sourceready_term:".length), term);
      }
      if (batch.length < 1000) break;
    }
    // SourceReady pass state per material: how many passes came back with
    // nothing, and whether the material is finished with this source.
    //
    // This used to be read out of `pageCursors`, which is only ever filled from
    // `discovery_page:%` keys, so the lookup could never match and the
    // one-pass credit gate silently did nothing. Its own map now.
    const sourceReadyPasses = new Map<string, { dry: number; done: boolean }>();
    for (let from = 0; ; from += 1000) {
      const { data: rows } = await admin
        .from("agent_state")
        .select("key, value")
        .eq("agent_id", ctx.agentId)
        .like("key", "sourceready_searched:%")
        .range(from, from + 999);
      const batch = (rows ?? []) as { key: string; value: any }[];
      for (const r of batch) {
        sourceReadyPasses.set(r.key.slice("sourceready_searched:".length), {
          dry: Number(r.value?.dry) || 0,
          // A marker written under a shape this reader does not recognise is
          // not an answer, so it does not get to be the final one. Defaulting
          // the missing key to `true` gated every one of the 15 markers that
          // predate the field off SourceReady permanently, for a material that
          // had simply been searched once — DISC-08, and the same fail-open
          // shape as PERS-03. Unknown means not finished: the material comes
          // back on the next pass and the pass writes a marker in this shape.
          done: r.value?.done === true,
        });
      }
      if (batch.length < 1000) break;
    }
    // Scout passes that failed on each material's last attempt, re-run ahead of
    // the rotation on this one.
    const scoutRetryPasses = new Map<string, string[]>();
    for (let from = 0; ; from += 1000) {
      const { data: rows } = await admin
        .from("agent_state")
        .select("key, value")
        .eq("agent_id", ctx.agentId)
        .like("key", "scout_retry_passes:%")
        .range(from, from + 999);
      const batch = (rows ?? []) as { key: string; value: any }[];
      for (const r of batch) {
        const keys = Array.isArray(r.value?.passes)
          ? r.value.passes.filter((k: any) => typeof k === "string")
          : [];
        if (keys.length) scoutRetryPasses.set(r.key.slice("scout_retry_passes:".length), keys);
      }
      if (batch.length < 1000) break;
    }
    if (!onlyMaterialId) {
      const targetTenkaraOrgIds = Array.from(sourcingTenkaraOrgIds);
      try {
        const universe = await queryMaterialsForOrgs(targetTenkaraOrgIds);
        // Paginate: Supabase caps a select at 1000 rows, and there are more than
        // 1000 active leads — an un-paginated fetch would undercount and falsely
        // mark materials as under-floor. (leadCount is function-scoped above.)
        const consumedCutoff = Date.now() - DEMAND_WINDOW_DAYS * 24 * 3600 * 1000;
        for (let from = 0; ; from += 1000) {
          const { data: rows } = await admin
            .from("leads_in_flight")
            .select("material_id, source, stage, updated_at")
            .eq("status", "active")
            .range(from, from + 999);
          const batch = (rows ?? []) as { material_id: string | null; source: string | null; stage: string | null; updated_at: string | null }[];
          for (const r of batch) {
            if (!r.material_id) continue;
            leadCount.set(r.material_id, (leadCount.get(r.material_id) ?? 0) + 1);
            if (r.source === "sourceready") srLeadCount.set(r.material_id, (srLeadCount.get(r.material_id) ?? 0) + 1);
            else if (r.source === "importyeti") iyLeadCount.set(r.material_id, (iyLeadCount.get(r.material_id) ?? 0) + 1);
            // A lead promoted to an outreach stage inside the window is proof the
            // material is being consumed, so discovery should keep feeding it.
            if (
              (r.stage === "ready_for_outreach" || r.stage === "ready_for_approval") &&
              Date.parse(r.updated_at ?? "") >= consumedCutoff
            ) {
              consumedRecent.set(r.material_id, (consumedRecent.get(r.material_id) ?? 0) + 1);
            }
          }
          if (batch.length < 1000) break;
        }
        const lastAttempt = new Map<string, number>();
        for (let from = 0; ; from += 1000) {
          const { data: rows } = await admin
            .from("agent_state")
            .select("key, value")
            .eq("agent_id", ctx.agentId)
            .like("key", "resource_attempt:%")
            .range(from, from + 999);
          const batch = (rows ?? []) as { key: string; value: any }[];
          for (const m of batch) {
            const id = m.key.slice("resource_attempt:".length);
            const at = Date.parse(m.value?.at ?? "");
            if (!Number.isNaN(at)) lastAttempt.set(id, at);
            if (typeof m.value?.dry === "number") dryStreak.set(id, m.value.dry);
            if (typeof m.value?.count === "number") lastAttemptCount.set(id, m.value.count);
          }
          if (batch.length < 1000) break;
        }
        const nowMs = Date.now();
        const already = new Set(materials.map((m) => m.id));
        let saturatedSkipped = 0;
        const underserved = universe
          // Demand gate: discover while under the floor, OR while outreach is
          // actively consuming this material's leads (breadth follows demand).
          .filter(
            (m) =>
              (leadCount.get(m.id) ?? 0) < DEMAND_GATE_FLOOR ||
              (consumedRecent.get(m.id) ?? 0) >= DEMAND_MIN_CONSUMED
          )
          .filter((m) => !already.has(m.id))
          .filter((m) => {
            const saturated = (dryStreak.get(m.id) ?? 0) >= DISCOVERY_DRY_STREAK_LIMIT;
            // Saturated internal-org materials are parked outright: scarce
            // discovery throughput goes to real clients, who keep the weekly re-check.
            if (saturated && INTERNAL_PARK_ON_SATURATION && isInternalMat(m)) {
              internalParked++;
              return false;
            }
            const la = lastAttempt.get(m.id);
            if (la === undefined) return true;
            const count = leadCount.get(m.id) ?? 0;
            // Dynamic backoff: fewer leads = scout more often (fast sourcing mode)
            // Below 100: every hour (ramp up fast), 100-300: every 8 hours (wean off), 300+: weekly
            let backoff = RESCOUT_BACKOFF_MS; // default 6h
            if (count < 100) backoff = 1 * 3600 * 1000;
            else if (count < 300) backoff = 8 * 3600 * 1000;
            else {
              // Saturated: weekly re-check for growth
              backoff = saturated ? SATURATED_BACKOFF_MS : 24 * 3600 * 1000;
            }
            const ready = nowMs - la > backoff;
            if (!ready && count >= 300) saturatedSkipped++;
            return ready;
          })
          .sort((a, b) => {
            // Primary key: real clients drain first, internal test orgs after.
            const aInternal = isInternalMat(a) ? 1 : 0;
            const bInternal = isInternalMat(b) ? 1 : 0;
            if (aInternal !== bInternal) return aInternal - bInternal;
            const aCount = leadCount.get(a.id) ?? 0;
            const bCount = leadCount.get(b.id) ?? 0;
            // Tier 0: <99 (highest priority, ramp up starved materials fast)
            // Tier 1: 99-120 (high priority, continue ramping)
            // Tier 2: 120-300 (medium priority, wean off diminishing returns)
            // Tier 3: 300+ (lowest priority, pick only if lower tiers exhausted)
            const aTier = aCount < 99 ? 0 : aCount < 120 ? 1 : aCount < 300 ? 2 : 3;
            const bTier = bCount < 99 ? 0 : bCount < 120 ? 1 : bCount < 300 ? 2 : 3;
            if (aTier !== bTier) return aTier - bTier;
            // Within each tier, fewest leads first
            return aCount - bCount ||
              (new Date(b.created_at as any).getTime() || 0) - (new Date(a.created_at as any).getTime() || 0);
          });
        // Real clients fill the pick budget first; internal test orgs get the
        // leftover, and never more than INTERNAL_MAX_PER_RUN (mirrors the
        // marketplace price-pull's real-first drain).
        const pickBudget = Math.max(0, 200 - materials.length);
        const realUnderserved = underserved.filter((m) => !isInternalMat(m));
        const internalUnderserved = underserved.filter((m) => isInternalMat(m));
        const realPicked = realUnderserved.slice(0, pickBudget);
        const internalPicked = internalUnderserved.slice(
          0,
          Math.min(INTERNAL_MAX_PER_RUN, Math.max(0, pickBudget - realPicked.length))
        );
        const picked = [...realPicked, ...internalPicked];
        for (const m of picked) underservedIds.add(m.id);
        materials = [...materials, ...picked];
        if (picked.length) {
          const pickedIds = picked.map((m) => m.id);
          for (let from = 0; ; from += 1000) {
            const { data: rows } = await admin
              .from("leads_in_flight")
              .select("material_id, payload")
              .eq("status", "active")
              .in("material_id", pickedIds)
              .range(from, from + 999);
            const batch = (rows ?? []) as { material_id: string; payload: any }[];
            for (const r of batch) {
              const h = hostOf(r.payload?.supplier_website ?? r.payload?.source_url ?? "");
              if (!h) continue;
              if (!existingHostsByMaterial.has(r.material_id)) existingHostsByMaterial.set(r.material_id, new Set());
              existingHostsByMaterial.get(r.material_id)!.add(h);
            }
            if (batch.length < 1000) break;
          }
        }
        // Publish the starvation verdict for the next run's throttle decision:
        // per org, how many materials sit below STARVATION_FLOOR and the earliest
        // time one of them becomes workable again (now, when a backoff has already
        // elapsed). Only covers the orgs sourced this run, which is enough: every
        // org still reaches a due run on its own interval, writes its verdict, and
        // is then un-throttled from the following tick until it clears the floor.
        try {
          const starvedOrgs: StarvedOrgs = {};
          for (const m of universe) {
            if ((leadCount.get(m.id) ?? 0) >= STARVATION_FLOOR) continue;
            const oaId = m.tenkara_org_id ? tenkaraOrgToOaOrg.get(m.tenkara_org_id) : null;
            if (!oaId) continue;
            const la = lastAttempt.get(m.id);
            const saturated = (dryStreak.get(m.id) ?? 0) >= DISCOVERY_DRY_STREAK_LIMIT;
            // A parked internal material never becomes workable, so it must not
            // hold the starvation bypass open for its org.
            if (saturated && INTERNAL_PARK_ON_SATURATION && isInternalByOaId.get(oaId)) continue;
            const readyAt = la === undefined ? nowMs : la + (saturated ? SATURATED_BACKOFF_MS : RESCOUT_BACKOFF_MS);
            const cur = starvedOrgs[oaId] ?? { starved: 0, next_at: null };
            cur.starved += 1;
            const prev = cur.next_at ? Date.parse(cur.next_at) : Infinity;
            if (readyAt < prev) cur.next_at = new Date(readyAt).toISOString();
            starvedOrgs[oaId] = cur;
          }
          await admin.from("agent_state").upsert(
            {
              agent_id: ctx.agentId,
              key: STARVED_ORGS_KEY,
              value: { orgs: starvedOrgs, floor: STARVATION_FLOOR, at: new Date().toISOString() },
            },
            { onConflict: "agent_id,key" }
          );
        } catch (e: any) {
          await ctx.log(`Starvation marker write failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "backlog" });
        }
        await ctx.log(
          `Backlog queue: ${underserved.length} materials in demand (below ${DEMAND_GATE_FLOOR}-lead floor or >=${DEMAND_MIN_CONSUMED} consumed in ${DEMAND_WINDOW_DAYS}d) · sourcing ${picked.length} this run (${realPicked.length} real, ${internalPicked.length} internal)` +
            (saturatedSkipped ? ` · ${saturatedSkipped} saturated (weekly re-check)` : "") +
            (internalParked ? ` · ${internalParked} internal parked (saturated)` : ""),
          { step: "backlog", data: { in_demand: underserved.length, picked: picked.length, real_picked: realPicked.length, internal_picked: internalPicked.length, saturated_skipped: saturatedSkipped, internal_parked: internalParked } }
        );
      } catch (e: any) {
        await ctx.log(`Backlog queue query failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "backlog" });
      }
    }

    // Real clients drain first: stable-partition the processing order so
    // internal-org materials only get whatever budget/time is left each run.
    if (!onlyMaterialId && materials.length > 1) {
      materials = [...materials.filter((m) => !isInternalMat(m)), ...materials.filter((m) => isInternalMat(m))];
    }

    // Priority bump: materials tagged is_priority=true in material_client_tags come
    // first in the processing order for their org. Purely a stable sort — no materials
    // are added or removed, and other orgs are unaffected. Fail-open: a query error
    // leaves the order unchanged. Only applied on cron runs (not targeted single-material).
    if (!onlyMaterialId) {
      try {
        const oaOrgIds = Array.from(new Set([...tenkaraOrgToOaOrg.values()].filter(Boolean)));
        if (oaOrgIds.length) {
          const { data: priorityRows } = await admin
            .from("material_client_tags")
            .select("tenkara_material_id")
            .in("org_id", oaOrgIds)
            .eq("is_priority", true);
          const prioritySet = new Set((priorityRows ?? []).map((r: any) => r.tenkara_material_id as string));
          if (prioritySet.size > 0) {
            const pri = materials.filter((m) => prioritySet.has(m.id));
            const rest = materials.filter((m) => !prioritySet.has(m.id));
            materials = [...pri, ...rest];
            await ctx.log(`Priority queue: moved ${pri.length} material(s) to front of run`, { step: "priority" });
          }
        }
      } catch (e: any) {
        await ctx.log(`Priority queue lookup failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "priority" });
      }
    }

    if (materials.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No new materials in window and none below the lead floor.");
      return;
    }

    // 3b-ii. Flag misspelled material names (e.g. "Butylene G;ycol"). Names come
    // from Tenkara (read-only); Agent flags a suggestion + pings ops, who apply
    // an OA-side override. Best-effort — never blocks discovery.
    try {
      const oaOrgName = new Map<string, string>();
      for (const r of (orgRows ?? []) as any[]) if (r.tenkara_org_id) oaOrgName.set(tenkaraOrgToOaOrg.get(r.tenkara_org_id)!, r.name);
      const namesByOrg = new Map<string, Set<string>>();
      for (const m of materials) {
        const oaId = m.tenkara_org_id ? tenkaraOrgToOaOrg.get(m.tenkara_org_id) : null;
        if (!oaId || !m.name) continue;
        if (!namesByOrg.has(oaId)) namesByOrg.set(oaId, new Set());
        namesByOrg.get(oaId)!.add(m.name);
      }
      let totalFlagged = 0;
      for (const [oaId, names] of namesByOrg) {
        totalFlagged += await flagMaterialNames(admin, oaId, Array.from(names), oaOrgName.get(oaId) ?? "client");
      }
      if (totalFlagged) await ctx.log(`Flagged ${totalFlagged} misspelled material name(s) → #control-room-feedback`, { step: "spelling" });
    } catch (e: any) {
      await ctx.log(`Material-name spelling check failed: ${e?.message ?? e}`, { level: "warn", step: "spelling" });
    }

    // 3b-ii-b. Flag duplicate material records (two rows for one substance, e.g.
    // "Butylene Glycol" + "Butylene Glycol 1,3"). Left split, both get scouted
    // and the same supplier is found — and emailed — twice for one chemical.
    // Compares across the org's WHOLE material set, not just this run's slice,
    // since the duplicate is usually an older record — which is also why this
    // can't be gated on the recency window. Instead it's time-throttled: the
    // extra Tenkara query is a flaky-pooler risk on the run's critical path, and
    // a duplicate that has sat for months doesn't need catching within the hour.
    // Best-effort throughout.
    const DUP_SCAN_INTERVAL_MS = 6 * 3600 * 1000;
    const dupScanDue = await (async () => {
      const { data } = await admin
        .from("agent_state")
        .select("value")
        .eq("agent_id", ctx.agentId)
        .eq("key", "duplicate_scan")
        .maybeSingle();
      const lastAt = Date.parse(((data?.value as any) ?? {}).at ?? "");
      return !Number.isFinite(lastAt) || Date.now() - lastAt >= DUP_SCAN_INTERVAL_MS;
    })().catch(() => true);

    // Scanned for EVERY mapped org, not just the ones sourcing is due for this
    // run: a duplicate is a data problem that an operator should see whether or
    // not the org is currently being scouted, and a paused org that later
    // resumes would otherwise start by burning discovery on both records.
    const dupScanTenkaraOrgIds = [...tenkaraOrgToOaOrg.keys()];

    if (!onlyMaterialId && dupScanDue && dupScanTenkaraOrgIds.length) {
      try {
        const oaOrgName = new Map<string, string>();
        for (const r of (orgRows ?? []) as any[]) if (r.tenkara_org_id) oaOrgName.set(tenkaraOrgToOaOrg.get(r.tenkara_org_id)!, r.name);
        const universe = await queryMaterialNamesAndGrades(dupScanTenkaraOrgIds);
        const byOrg = new Map<string, MergeMaterial[]>();
        for (const m of universe) {
          const oaId = m.tenkara_org_id ? tenkaraOrgToOaOrg.get(m.tenkara_org_id) : null;
          if (!oaId) continue;
          if (!byOrg.has(oaId)) byOrg.set(oaId, []);
          byOrg.get(oaId)!.push({ id: m.id, name: m.name, grades: m.grades ?? [], created_at: m.created_at });
        }
        let dupFlagged = 0;
        for (const [oaId, mats] of byOrg) {
          dupFlagged += await flagDuplicateMaterials(admin, oaId, mats, oaOrgName.get(oaId) ?? "client");
        }
        // Only bank the throttle marker on a scan that actually completed, so a
        // Tenkara timeout retries next run instead of parking for 6h.
        await admin
          .from("agent_state")
          .upsert({ agent_id: ctx.agentId, key: "duplicate_scan", value: { at: new Date().toISOString() } }, { onConflict: "agent_id,key" });
        if (dupFlagged) await ctx.log(`Flagged ${dupFlagged} duplicate material pair(s) → #control-room-feedback`, { step: "duplicates" });
      } catch (e: any) {
        await ctx.log(`Duplicate-material check failed: ${e?.message ?? e}`, { level: "warn", step: "duplicates" });
      }
    }

    // 3b-ii-c. Drop materials an operator has already merged away. Their leads
    // now live under the survivor, so re-scouting them would rebuild the very
    // duplicate the merge just resolved. Fail-open: a query error changes nothing.
    try {
      const { data: mergedRows } = await admin
        .from("material_merge_flags")
        .select("drop_material_id")
        .eq("status", "applied");
      const mergedAway = new Set((mergedRows ?? []).map((r: any) => r.drop_material_id as string));
      if (mergedAway.size) {
        const before = materials.length;
        materials = materials.filter((m) => !mergedAway.has(m.id));
        const skipped = before - materials.length;
        if (skipped) await ctx.log(`Skipped ${skipped} material(s) merged into another record`, { step: "duplicates" });
      }
    } catch (e: any) {
      await ctx.log(`Merged-material skip lookup failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "duplicates" });
    }

    // 3b-ii-d. Drop materials the client supplies themselves. They flip
    // self_supplied on the Tenkara material form to say "we already have this";
    // sourcing it wastes discovery budget on a material they will never buy from
    // us. Sits after the recency + backlog merge so it covers every entry path
    // (window, backlog, targeted). DISC-09: fails closed — if the flag cannot be
    // read, this pass stages nothing rather than scouting a material the client
    // makes themselves.
    {
      const selfSupplied = await loadSelfSuppliedMaterials();
      if (!selfSupplied.known) {
        await ctx.log(selfSuppliedUnavailable(selfSupplied.reason), { level: "warn", step: "query" });
        ctx.setStatus("partial");
        ctx.setSummary("Self-supplied lookup unavailable; no discovery this pass.");
        return;
      }
      const before = materials.length;
      materials = materials.filter((m) => !selfSupplied.ids.has(m.id));
      const skipped = before - materials.length;
      if (skipped) await ctx.log(`Skipped ${skipped} self-supplied material(s)`, { step: "query" });
    }

    // 3b-iii. Applied spelling overrides (org → lower(wrong)→correct), used to
    // correct material names on newly-staged leads.
    const overridesByOrg = new Map<string, Map<string, string>>();
    {
      const oaIds = Array.from(new Set(Array.from(tenkaraOrgToOaOrg.values())));
      if (oaIds.length) {
        const { data: applied } = await admin
          .from("material_name_flags")
          .select("org_id, wrong_name, suggested_name")
          .in("org_id", oaIds)
          .eq("status", "applied");
        for (const r of (applied ?? []) as any[]) {
          if (!overridesByOrg.has(r.org_id)) overridesByOrg.set(r.org_id, new Map());
          overridesByOrg.get(r.org_id)!.set((r.wrong_name as string).toLowerCase(), r.suggested_name);
        }
      }
    }

    // 3c. Per-material idempotency for the scout phase. Equivalent to Ben's
    //     `processed_material_ids` set in sourcing-trigger.json — once a
    //     material has any scout-discovered lead, we don't re-scout it (the
    //     model would just re-find the same hosts and we'd waste API calls
    //     + risk duplicate inserts).
    const materialIds = materials.map((m) => m.id);
    const { data: scoutedRows } = await admin
      .from("leads_in_flight")
      .select("material_id")
      .eq("source", "ai_discovery")
      .in("material_id", materialIds);
    const alreadyScouted = new Set((scoutedRows ?? []).map((r: any) => r.material_id as string));
    // Targeted runs force a fresh scout even if the material already has leads.
    if (onlyMaterialId) alreadyScouted.clear();
    if (alreadyScouted.size > 0) {
      await ctx.log(`${alreadyScouted.size} materials already have scout leads — skipping scout phase for them`, {
        step: "scout_dedup",
      });
    }

    // 3d. Per-(material, supplier) idempotency for the GRAPH phase. Without this
    //     a material sitting in the lookback window gets its graph candidates
    //     re-inserted on every cron tick, since findCandidatesForMaterial is
    //     deterministic. Guard directly against leads already in
    //     leads_in_flight for these materials. Applies to targeted runs too:
    //     re-inserting an identical (material, supplier) row is never useful.
    const { data: existingGraphLeads } = await admin
      .from("leads_in_flight")
      .select("material_id, supplier_id")
      .in("material_id", materialIds)
      .not("supplier_id", "is", null);
    const existingMaterialSupplier = new Set(
      (existingGraphLeads ?? []).map((r: any) => `${r.material_id}|${r.supplier_id}`)
    );
    if (existingMaterialSupplier.size > 0) {
      await ctx.log(`${existingMaterialSupplier.size} (material,supplier) pairs already staged — graph dedup active`, {
        step: "graph_dedup",
      });
    }

    // 3e. Per-(material, canonical company name) dedup. The supplier_id guard above
    //     only catches graph leads (scout / SourceReady / ImportYeti carry
    //     supplier_id=null), and the host guard can't unify a supplier listed under
    //     different domains (e.g. chemicals.basf.com vs a pharmacompass listing) or
    //     the same supplier under a name variant ("BASF" vs "BASF SE"). Key on
    //     (material_id | normalizeCompanyName(name)) so distinct materials for the
    //     same supplier remain separate leads, but the same supplier+material never
    //     lands twice. Seeded from existing active leads, then updated as we stage.
    const { data: existingNameRows } = await admin
      .from("leads_in_flight")
      .select("material_id, supplier_name")
      .eq("status", "active")
      .in("material_id", materialIds);
    const stagedNameKeys = new Set<string>();
    for (const r of (existingNameRows ?? []) as { material_id: string | null; supplier_name: string | null }[]) {
      const norm = normalizeCompanyName(r.supplier_name);
      if (r.material_id && norm) stagedNameKeys.add(`${r.material_id}|${norm}`);
    }
    // Returns true if this (material, company) was already seen; otherwise records
    // it and returns false. Blank/normalize-to-empty names are never deduped.
    const nameSeen = (materialId: string, name: string | null | undefined): boolean => {
      const norm = normalizeCompanyName(name);
      if (!norm) return false;
      const key = `${materialId}|${norm}`;
      if (stagedNameKeys.has(key)) return true;
      stagedNameKeys.add(key);
      return false;
    };
    if (stagedNameKeys.size > 0) {
      await ctx.log(`${stagedNameKeys.size} (material,company) names already staged — name dedup active`, {
        step: "name_dedup",
      });
    }

    // 4. AI scout config — Anthropic web_search tool. If no key, scout phase
    //    is skipped silently and we run graph-only.
    const scoutEnabled = !!process.env.ANTHROPIC_API_KEY;
    if (!scoutEnabled) {
      await ctx.log("ANTHROPIC_API_KEY not set — AI scout discovery skipped (graph-only mode)", {
        step: "config",
        level: "info",
      });
    }

    // 5. For each material, find candidates and stage leads.
    let leadsCreated = 0;
    let scoutLeadsCreated = 0;
    let reuseLeadsCreated = 0;
    let materialsWithLeads = 0;
    let materialsWithoutLeads = 0;
    let materialsWithScoutLeads = 0;
    let skippedByExisting = 0;
    let skippedByExclusion = 0;
    let skippedByName = 0;
    let sourceReadyFired = 0;
    let importYetiFired = 0;
    const noLeadMaterials: string[] = [];

    // A discovery source that hard-fails must not leave the run reporting
    // "success". SourceReady died on 2026-08-08 and every subsequent run stayed
    // green with the outage recorded only as a per-material warn event, so the
    // /agents dashboard, the fleet summary and anyone glancing at the run list
    // all read a dead source as a healthy one for two days. A source erroring is
    // anomalous by definition, so it degrades the run to `partial` and is named
    // in the summary where it cannot be missed.
    //
    // Scout PASS aborts are counted but deliberately do NOT degrade the status:
    // one of three passes timing out is currently the steady state, so alerting
    // on it would make agent-03 permanently partial and teach everyone to ignore
    // the signal. The consequence of those aborts is caught where it actually
    // matters, by agent-16's breadth check on the material's supplier count.
    const sourceFailures = new Map<string, { count: number; sample: string }>();
    const noteSourceFailure = (source: string, message: string) => {
      const cur = sourceFailures.get(source);
      if (cur) cur.count++;
      else sourceFailures.set(source, { count: 1, sample: message });
    };
    let scoutPassFailures = 0;

    // Per-client sourcing exclusions (do-not-contact companies + excluded
    // countries), fetched once per Tenkara org and cached for the run. Fail-open
    // here: a transient Tenkara read shouldn't block lead creation — Agent 04
    // re-checks fail-closed before any email actually goes out.
    const exclusionCache = new Map<string, SourcingExclusions>();
    const exclusionsFor = async (tenkaraOrgId: string | null | undefined): Promise<SourcingExclusions | null> => {
      if (!tenkaraOrgId) return null;
      if (exclusionCache.has(tenkaraOrgId)) return exclusionCache.get(tenkaraOrgId)!;
      try {
        const ex = await getSourcingExclusions(tenkaraOrgId);
        // Fold in free-text sourcing rules (e.g. "No China please") from the OA
        // client notes so a written rule suppresses suppliers just like a typed
        // country exclusion in Tenkara does.
        const oaOrgId = tenkaraOrgToOaOrg.get(tenkaraOrgId) ?? null;
        if (oaOrgId) {
          const { aliases, hits } = await getNoteDerivedCountryExclusions(admin, oaOrgId);
          if (aliases.size) {
            aliases.forEach((a) => ex.excludedCountries.add(a));
            ex.raw.countries += aliases.size;
            await ctx.log(
              `Note-derived country exclusions for org ${oaOrgId}: ${hits.map((h) => h.country).join(", ")} (from ops notes)`,
              { step: "exclusions", data: { hits } }
            );
          }
        }
        exclusionCache.set(tenkaraOrgId, ex);
        return ex;
      } catch (e: any) {
        await ctx.log(`Sourcing-exclusions lookup failed for org ${tenkaraOrgId} (non-fatal): ${e?.message ?? e}`, {
          level: "warn",
          step: "exclusions",
        });
        return null;
      }
    };

    for (const material of materials) {
      // Per-org sourcing switch: only source for materials whose org allows
      // discovery (status active/sourcing_only). Skip 'off' orgs entirely.
      if (!onlyMaterialId && (!material.tenkara_org_id || !sourcingTenkaraOrgIds.has(material.tenkara_org_id))) {
        continue;
      }
      if (leadsCreated >= MAX_NEW_LEADS_PER_RUN) {
        await ctx.log(`Hit MAX_NEW_LEADS_PER_RUN=${MAX_NEW_LEADS_PER_RUN}; stopping`, { step: "cap" });
        break;
      }
      if (elapsedMs() > DRIVE_BUDGET_MS) {
        await ctx.log(`Drive budget reached; deferring remaining materials to next run`, { step: "budget" });
        break;
      }

      // Apply any operator-approved spelling correction so a (forced) re-scout
      // doesn't re-introduce the Tenkara typo into new leads.
      const matOaOrgId = material.tenkara_org_id ? tenkaraOrgToOaOrg.get(material.tenkara_org_id) ?? null : null;
      const matLabel = correctName(
        matOaOrgId ? overridesByOrg.get(matOaOrgId) ?? EMPTY_OVERRIDES : EMPTY_OVERRIDES,
        materialLabel(material, material.id) as string
      ) as string;

      // Every source matches on the string we hand it, so our intake-form name
      // being one word off the catalogue name reads as "no suppliers exist"
      // rather than "wrong name". Resolved lazily, once per material, cached.
      let aliasesResolved: string[] | null = null;
      const materialAliases = async (): Promise<string[]> => {
        if (aliasesResolved === null) {
          aliasesResolved = await getMaterialAliases(
            admin,
            ctx.agentId,
            { id: material.id, name: matLabel, inci: material.inci ?? null },
            (msg, meta) => ctx.log(msg, { step: "aliases", data: { ...meta, material_id: material.id } })
          );
        }
        return aliasesResolved;
      };

      let candidates: CandidateSupplier[];
      try {
        candidates = await findCandidatesForMaterial(material);
      } catch (e: any) {
        await ctx.log(`Candidate query failed for material ${matLabel}: ${e.message}`, {
          level: "warn",
          step: "candidates",
          data: { material_id: material.id },
        });
        continue;
      }

      // Dedup graph candidates by supplier_id (keep best signal — order in sql.ts
      // already prefers stronger signals, so first wins).
      const seen = new Map<string, CandidateSupplier>();
      for (const c of candidates) {
        if (!seen.has(c.supplier_id)) seen.set(c.supplier_id, c);
      }
      const unique = Array.from(seen.values());

      // Skip candidates we've already staged for this material (real idempotency)
      // then the legacy mirror-based skip (supplier_name × material_name match).
      const fresh: CandidateSupplier[] = [];
      for (const c of unique) {
        if (existingMaterialSupplier.has(`${material.id}|${c.supplier_id}`)) {
          skippedByExisting++;
          continue;
        }
        if (nameSeen(material.id, c.supplier_name)) {
          skippedByName++;
          continue;
        }
        fresh.push(c);
      }
      if (unique.length > 0 && fresh.length === 0) {
        await ctx.log(`All ${unique.length} graph candidates for ${matLabel} already staged`, {
          step: "dedup",
          data: { material_id: material.id },
        });
      }

      // Resolve OA org_id from the material's Tenkara organization. Null if
      // the org isn't registered in OA yet — we still stage the lead, it just
      // shows as "cross-org" in the UI until the org is onboarded.
      const oaOrgId = material.tenkara_org_id
        ? tenkaraOrgToOaOrg.get(material.tenkara_org_id) ?? null
        : null;
      if (material.tenkara_org_id && !oaOrgId) {
        await ctx.log(`No OA org mapping for tenkara_org_id=${material.tenkara_org_id}; staging unscoped`, {
          step: "org_map",
          level: "warn",
          data: { material_id: material.id, tenkara_org_id: material.tenkara_org_id },
        });
      }

      // 5a-pre. Drop candidates the client has excluded — do-not-contact
      //         companies or excluded-country suppliers (Tenkara client
      //         settings). Applied to both graph and scout candidates below.
      const ex = await exclusionsFor(material.tenkara_org_id);
      const keepIfAllowed = <T extends { supplier_name?: string | null }>(
        rows: T[],
        get: (r: T) => { name?: string | null; website?: string | null; country?: string | null }
      ): T[] => {
        if (!ex || ex.raw.companies + ex.raw.countries === 0) return rows;
        const kept: T[] = [];
        for (const r of rows) {
          const reason = exclusionReason(get(r), ex);
          if (reason) {
            skippedByExclusion++;
            continue;
          }
          kept.push(r);
        }
        return kept;
      };

      const freshAllowed = keepIfAllowed(fresh, (c) => ({
        name: c.supplier_name,
        website: c.supplier_website,
        country: c.supplier_country,
      }));
      if (fresh.length > 0 && freshAllowed.length < fresh.length) {
        await ctx.log(
          `Excluded ${fresh.length - freshAllowed.length} graph candidate(s) for ${matLabel} (do-not-contact / excluded country)`,
          { step: "exclusions", data: { material_id: material.id } }
        );
      }

      // 5a. Stage graph-derived leads first (high confidence, deterministic).
      let stagedThisMaterial = 0;
      const graphHosts = new Set<string>();
      if (freshAllowed.length > 0) {
        const budget = MAX_NEW_LEADS_PER_RUN - leadsCreated;
        const toInsert = freshAllowed.slice(0, budget).map((c) => ({
          org_id: oaOrgId,
          supplier_name: c.supplier_name,
          supplier_id: c.supplier_id,
          material_name: matLabel,
          material_id: material.id,
          stage: "raw" as const,
          status: "active" as const,
          source: sourceFromSignal(c.signal),
          payload: {
            inci_name: material.inci,
            supplier_website: cleanSupplierWebsite(c.supplier_website),
            supplier_contact_name: c.supplier_poc_name,
            supplier_contact_email: c.supplier_poc_email,
            supplier_country: c.supplier_country,
            signal: c.signal,
            signal_count: c.signal_count,
            confidence_reason: describeCandidateConfidence(c),
            relevance_tier: SIGNAL_RELEVANCE[c.signal],
            tenkara_org_id: material.tenkara_org_id,
          },
          confidence_score: scoreCandidate(c),
          agent_run_id: ctx.runId,
        }));
        for (const c of freshAllowed) {
          const h = hostOf(c.supplier_website);
          if (h) graphHosts.add(h);
        }

        const { error: insErr, data: inserted } = await admin
          .from("leads_in_flight")
          .insert(toInsert)
          .select("id");
        if (insErr) {
          await ctx.log(`Graph insert failed for ${matLabel}: ${insErr.message}`, {
            level: "error",
            step: "insert",
            data: { material_id: material.id },
          });
        } else {
          stagedThisMaterial += inserted?.length ?? 0;
          leadsCreated += inserted?.length ?? 0;
          await ctx.log(`Staged ${inserted?.length ?? 0} graph leads for ${matLabel}`, {
            step: "insert",
            data: {
              material_id: material.id,
              material_name: matLabel,
              lead_ids: (inserted ?? []).map((r: any) => r.id),
            },
          });
        }
      }

      const isBacklogRescout = underservedIds.has(material.id);

      // 5a-bis. DB reuse: leads already discovered for a sibling material with
      // the same trade name are free breadth, so stage them before any paid
      // source fires. Gated like scout (new or backlog materials only).
      if (
        DB_REUSE_ENABLED &&
        (isBacklogRescout || !alreadyScouted.has(material.id)) &&
        leadsCreated < MAX_NEW_LEADS_PER_RUN
      ) {
        try {
          const r = await runDbReuse(admin, {
            material,
            matLabel,
            aliases: await materialAliases(),
            oaOrgId,
            nameSeen,
            existingMaterialSupplier,
            keepIfAllowed,
            runId: ctx.runId,
            cap: Math.min(DB_REUSE_MAX_PER_MATERIAL, MAX_NEW_LEADS_PER_RUN - leadsCreated),
            log: (msg, meta) => {
              const { level, ...rest } = (meta ?? {}) as { level?: "info" | "warn" | "error" };
              return ctx.log(msg, {
                step: "db_reuse",
                ...(level ? { level } : {}),
                data: { ...rest, material_id: material.id },
              });
            },
          });
          stagedThisMaterial += r.inserted;
          leadsCreated += r.inserted;
          reuseLeadsCreated += r.inserted;
          for (const h of r.hosts) graphHosts.add(h);
        } catch (e: any) {
          await ctx.log(`DB reuse failed for ${matLabel} (non-fatal): ${e?.message ?? e}`, {
            level: "warn",
            step: "db_reuse",
            data: { material_id: material.id },
          });
        }
      }

      // 5b. AI scout — runs whenever ANTHROPIC_API_KEY is set AND we haven't
      //     already produced scout leads for this material in a prior run
      //     (Ben's processed_material_ids equivalent). Dedups by host vs graph
      //     hits so we don't double-stage the same supplier.
      // Scout when there are no scout leads yet, OR when this material is a
      // backlog re-scout (below the richness floor and past its backoff window).
      // Did discovery actually get to look at this material this run? A pass that
      // timed out, or an index source that was down, means "we did not look" —
      // which must never be recorded as "we looked and the market is empty".
      let scoutRan = false;
      let scoutHardFailed = false;
      let discoveryDegraded = false;
      if (scoutEnabled && leadsCreated < MAX_NEW_LEADS_PER_RUN && (!alreadyScouted.has(material.id) || isBacklogRescout)) {
        // Exclude hosts we already have for this material (graph hits this run +
        // existing leads from prior runs) so a re-scout only adds NEW suppliers —
        // scout leads carry no supplier_id, so the graph dedup can't catch dupes.
        const excludeHosts = new Set<string>(graphHosts);
        for (const h of existingHostsByMaterial.get(material.id) ?? []) excludeHosts.add(h);
        let scoutResults: ScoutSupplier[] = [];
        scoutRan = true;
        // The marketplace and retail buckets are where aggregator sellers and
        // published price ladders come from, and the rotation reaches them only
        // 2 runs in 6 — on rapeseed it drew `marketplace` once, where the pass
        // aborted, so the material had no marketplace supplier at all a day
        // later. If we hold no marketplace host for this material yet, that
        // bucket is not a rotation slot we can afford to leave to chance.
        const hasMarketplaceLead = Array.from(existingHostsByMaterial.get(material.id) ?? []).some((h) =>
          isAggregatorHost(h)
        );
        try {
          scoutResults = await scoutSuppliersForMaterial(material, {
            excludeHosts,
            aliases: await materialAliases(),
            log: (msg, meta) => {
              // `level` arrives inside meta; without hoisting it out, a failed
              // pass was filed as an ordinary info event and read as routine.
              const { level, ...rest } = (meta ?? {}) as { level?: "info" | "warn" | "error" };
              return ctx.log(msg, {
                step: "scout",
                ...(level ? { level } : {}),
                data: { ...rest, material_id: material.id },
              });
            },
            retryPasses: scoutRetryPasses.get(material.id) ?? [],
            requirePasses: hasMarketplaceLead ? [] : ["marketplace", "chem_platforms"],
            onPassOutcome: async (barrenKeys, failedKeys) => {
              scoutPassFailures += barrenKeys.length;
              if (failedKeys.length) discoveryDegraded = true;
              if (barrenKeys.length) {
                await admin.from("agent_state").upsert(
                  {
                    agent_id: ctx.agentId,
                    key: SCOUT_RETRY_KEY(material.id),
                    value: { passes: barrenKeys, at: new Date().toISOString() },
                  },
                  { onConflict: "agent_id,key" }
                );
              } else if (scoutRetryPasses.has(material.id)) {
                await admin
                  .from("agent_state")
                  .delete()
                  .eq("agent_id", ctx.agentId)
                  .eq("key", SCOUT_RETRY_KEY(material.id));
              }
            },
          });
        } catch (e: any) {
          scoutHardFailed = true;
          await ctx.log(`Scout failed for ${matLabel}: ${e.message}`, {
            level: "warn",
            step: "scout",
            data: { material_id: material.id },
          });
        }
        const scoutAllowed = keepIfAllowed(scoutResults, (s) => ({
          name: s.supplier_name,
          website: s.url,
          country: s.country,
        }));
        if (scoutResults.length > 0 && scoutAllowed.length < scoutResults.length) {
          await ctx.log(
            `Excluded ${scoutResults.length - scoutAllowed.length} scout candidate(s) for ${matLabel} (do-not-contact / excluded country)`,
            { step: "exclusions", data: { material_id: material.id } }
          );
        }

        // Same canonical-name dedup applied to graph leads (§3e): drop scout
        // suppliers already staged for this material under any name variant,
        // including the graph leads just inserted above this run.
        const scoutDeduped = scoutAllowed.filter((s) => {
          if (nameSeen(material.id, s.supplier_name)) {
            skippedByName++;
            return false;
          }
          return true;
        });
        if (scoutAllowed.length > scoutDeduped.length) {
          await ctx.log(
            `Deduped ${scoutAllowed.length - scoutDeduped.length} scout candidate(s) for ${matLabel} (same supplier already staged)`,
            { step: "name_dedup", data: { material_id: material.id } }
          );
        }

        if (scoutDeduped.length > 0) {
          const scoutBudget = MAX_NEW_LEADS_PER_RUN - leadsCreated;
          const scoutToInsert = scoutDeduped.slice(0, scoutBudget).map((s) => ({
            org_id: oaOrgId,
            supplier_name: s.supplier_name,
            supplier_id: null,                  // no Tenkara supplier_id — new discovery
            material_name: matLabel,
            material_id: material.id,
            stage: "raw" as const,
            status: "active" as const,
            source: "ai_discovery" as const,
            payload: {
              inci_name: material.inci,
              trade_name: s.trade_name,
              supplier_website: cleanSupplierWebsite(s.url),
              supplier_contact_email: s.email,
              supplier_phone: s.phone,
              supplier_country: s.country,
              supplier_role: s.role,             // Manufacturer / Distributor / Reseller / Trader / Marketplace
              hq_address: s.hq_address,
              supplier_background: s.supplier_background,
              pack_sizes_pricing: s.pack_sizes_pricing,
              grades_offered: s.grades_offered,
              certifications: s.certifications,
              moq: s.moq,
              site_type: s.site_type,            // M / MS / A / N — surfaced in UI
              confidence_hint: s.confidence_hint,
              confidence_reason: describeScoutConfidence(s.confidence_hint),
              relevance_tier: s.confidence_hint === "strong" ? "Confirmed" : "Potential",
              completeness_score: scoutCompleteness(s),
              source_url: s.url,
              source_citations: s.source_citations,
              scout_notes: s.notes,
              tenkara_org_id: material.tenkara_org_id,
            },
            confidence_score: scoreScoutConfidence(s.confidence_hint),
            agent_run_id: ctx.runId,
          }));

          const { error: scoutErr, data: scoutInserted } = await admin
            .from("leads_in_flight")
            .insert(scoutToInsert)
            .select("id");
          if (scoutErr) {
            await ctx.log(`Scout insert failed for ${matLabel}: ${scoutErr.message}`, {
              level: "error",
              step: "scout",
              data: { material_id: material.id },
            });
          } else {
            const n = scoutInserted?.length ?? 0;
            stagedThisMaterial += n;
            scoutLeadsCreated += n;
            leadsCreated += n;
            if (n > 0) materialsWithScoutLeads++;
            await ctx.log(`Staged ${n} scout leads for ${matLabel}`, {
              step: "scout",
              data: {
                material_id: material.id,
                material_name: matLabel,
                lead_ids: (scoutInserted ?? []).map((r: any) => r.id),
              },
            });
          }
        }
      }

      // What the trade calls this material, for the index-backed sources. Both
      // 5c. SourceReady discovery — run in-process: calls supplier_search_v3 over
      //     the upstream MCP endpoint, parses the markdown profiles, and stages
      //     source='sourceready' leads inline. Gated like scout (new or backlog
      //     materials only) and capped per run to bound cost. Exclusions here are
      //     best-effort; Agent 04 re-checks do-not-contact / excluded countries
      //     before any email is sent.
      //
      // CREDIT-SAVING CHANGE (2026-08-11): SourceReady is now ONE-PASS-ONLY per material.
      // Once searched, a material is marked sourceready_searched and never re-queried
      // (except via explicit manual override). This prevents pagination loops from
      // burning credits on repeat pages. Scout and ImportYeti handle breadth; SourceReady
      // is a initial deep index, not a recurring crawler.
      const srBacklog = underservedIds.has(material.id);
      const srAlreadySearched = sourceReadyPasses.get(material.id)?.done === true;
      if (
        sourceReadyEnabled() &&
        sourceReadyFired < SOURCEREADY_MAX_MATERIALS_PER_RUN &&
        !srAlreadySearched &&
        (!alreadyScouted.has(material.id) || srBacklog)
      ) {
        const excludeHosts = new Set<string>(graphHosts);
        for (const h of existingHostsByMaterial.get(material.id) ?? []) excludeHosts.add(h);
        // One-pass model: page 1, size 100. If it exists, fetch it. No pagination.
        const srPage = 1;
        let ok = false;
        let srDetail: Record<string, any> = {};
        let srError: string | null = null;
        let srVerdict: ReturnType<typeof classifyFailure> | null = null;
        try {
          const r = await runSourceReadyDiscovery(
            admin,
            {
              oaOrgId,
              materialId: material.id,
              materialName: matLabel,
              inci: material.inci ?? null,
              tenkaraOrgId: material.tenkara_org_id ?? null,
              excludeHosts: Array.from(excludeHosts),
              excludedCountries: ex ? Array.from(ex.excludedCountries) : [],
              size: SOURCEREADY_PAGE_SIZE,
              page: srPage,
              unlockContacts:
                sourceReadyUnlockEnabled() && !!oaOrgId && !isInternalByOaId.get(oaOrgId),
              aliases: await materialAliases(),
              preferredTerm: sourceReadyTerms.get(material.id),
              log: (msg, meta) => ctx.log(msg, { step: "sourceready", data: meta }),
            },
            ctx.runId
          );
          ok = r.ok;
          srDetail = {
            received: r.received, inserted: r.inserted, skipped: r.skipped,
            reason: r.reason, unlocked: r.unlocked,
            used_term: r.usedTerm, terms_tried: r.termsTried,
          };
          stagedThisMaterial += r.inserted;
          // Cache the winning term so the next fire opens with it instead of
          // paying its way down the alias list again.
          if (r.usedTerm && r.received > 0 && sourceReadyTerms.get(material.id) !== r.usedTerm) {
            sourceReadyTerms.set(material.id, r.usedTerm);
            await admin.from("agent_state").upsert(
              {
                agent_id: ctx.agentId,
                key: SOURCEREADY_TERM_KEY(material.id),
                value: { term: r.usedTerm, at: new Date().toISOString() },
              },
              { onConflict: "agent_id,key" }
            );
          }
        } catch (e: any) {
          srError =
            e instanceof SourceReadyUnavailableError
              ? "mcp_unavailable"
              : (e?.message ?? String(e));
          srVerdict = classifyFailure(e);
          noteSourceFailure("sourceready", srError ?? "unknown");
        }
        if (ok || srError) {
          sourceReadyFired++;
          // When to stop asking this source about this material.
          //
          // Two rules meet here. Credits are scarce, so a material that has been
          // properly searched must not be re-queried every run. But zero is not
          // "this market is empty": it is indistinguishable from a naming miss
          // or a bad run, and writing a material off on one empty answer is how
          // Rapeseed Fatty Acid sat at zero suppliers for four days while three
          // marketplaces carried it.
          //
          // So: a pass that RETURNED suppliers is done. A pass that returned
          // nothing counts as a dry pass and the material comes back until the
          // dry streak is spent. A retryable failure (the endpoint was down) is
          // not a pass at all, costs no credits, and is not counted.
          const found = ok && (srDetail.received ?? 0) > 0;
          const infra = !!srError && srVerdict?.verdict === "retry";
          const { dry, done, persist, note: boundNote } = advanceDryPass(
            sourceReadyPasses.get(material.id) ?? null,
            passOutcome(found, infra),
            "sourceready_search"
          );
          // PERS-04: the bound is a spend decision, so it is said out loud in
          // the run summary rather than left as a counter in a jsonb column.
          if (boundNote) await ctx.log(`Retry bound reached — ${material.name}: ${boundNote}`, { step: "sourceready" });
          if (persist) {
            sourceReadyPasses.set(material.id, { dry, done });
            await admin.from("agent_state").upsert(
              {
                agent_id: ctx.agentId,
                key: SOURCEREADY_SEARCHED_KEY(material.id),
                value: {
                  searched_at: new Date().toISOString(),
                  run_id: ctx.runId,
                  dry,
                  done,
                  last_reason: found ? "found" : (srError ?? srDetail.reason ?? "no_results"),
                },
              },
              { onConflict: "agent_id,key" }
            );
          }
        }
        await ctx.log(
          ok
            ? `SourceReady discovery (one-pass) for ${matLabel}: staged ${srDetail.inserted ?? 0} of ${srDetail.received ?? 0}`
            : `SourceReady discovery failed for ${matLabel}: ${srError ?? "unknown"}`,
          {
            step: "sourceready",
            level: ok ? "info" : "warn",
            data: { material_id: material.id, ...srDetail, error: srError },
          }
        );
      }

      // 5d. ImportYeti discovery — mirror of 5c, but run in-process: pulls
      //     US-customs suppliers, filters, and stages source='importyeti' leads
      //     inline. Contacts are resolved downstream by Agent 06. Same gating
      //     (new/backlog materials only) and per-run cap. Exclusions
      //     best-effort; Agent 04 re-checks before email.
      if (
        importYetiEnabled() &&
        importYetiFired < IMPORTYETI_MAX_MATERIALS_PER_RUN &&
        (!alreadyScouted.has(material.id) || srBacklog)
      ) {
        const iyCursor = advancePageCursor(
          pageCursors.get(`importyeti:${material.id}`),
          iyLeadCount.get(material.id) ?? 0,
          !onlyMaterialId,
          IMPORTYETI_PAGE_SIZE
        );
        const iyPage = iyCursor.page;
        let iyPersist = iyCursor;
        let ok = false;
        let iyDetail: Record<string, any> = {};
        let iyError: string | null = null;
        try {
          const r = await runImportYetiDiscovery(
            admin,
            {
              oaOrgId,
              materialId: material.id,
              materialName: matLabel,
              inci: material.inci ?? null,
              tenkaraOrgId: material.tenkara_org_id ?? null,
              excludedCountries: ex ? Array.from(ex.excludedCountries) : [],
              size: IMPORTYETI_PAGE_SIZE,
              page: iyPage,
              aliases: await materialAliases(),
              log: (msg, meta) => ctx.log(msg, { step: "importyeti", data: meta }),
            },
            ctx.runId
          );
          ok = r.ok;
          if ((r.received ?? 0) === 0) iyPersist = cursorAfterEmptyPage(iyCursor, iyCursor.count);
          iyDetail = { received: r.received, inserted: r.inserted, skipped: r.skipped, reason: r.reason };
          stagedThisMaterial += r.inserted;
        } catch (e: any) {
          // ImportYeti 500s flap in bursts. Leave the cursor unadvanced so the
          // same page is retried next run rather than being skipped.
          iyError = e instanceof ImportYetiUnavailableError ? "api_unavailable" : (e?.message ?? String(e));
          noteSourceFailure("importyeti", iyError ?? "unknown");
        }
        if (ok) {
          importYetiFired++;
          await admin.from("agent_state").upsert(
            {
              agent_id: ctx.agentId,
              key: PAGE_CURSOR_KEY("importyeti", material.id),
              value: { ...iyPersist, at: new Date().toISOString() },
            },
            { onConflict: "agent_id,key" }
          );
        }
        await ctx.log(
          ok
            ? `ImportYeti discovery for ${matLabel} (page ${iyPage}): staged ${iyDetail.inserted ?? 0} of ${iyDetail.received ?? 0}`
            : `ImportYeti discovery failed for ${matLabel}: ${iyError ?? "unknown"}`,
          {
            step: "importyeti",
            level: ok ? "info" : "warn",
            data: { material_id: material.id, page: iyPage, dry_pages: iyCursor.dry, ...iyDetail, error: iyError },
          }
        );
      }

      // Record the attempt so a scout that surfaces nothing new still backs off —
      // it won't be re-run until RESCOUT_BACKOFF elapses. Also track diminishing
      // returns: compare the current lead count to the count at the last attempt;
      // if the material grew by fewer than MIN_NEW_PER_CYCLE leads (across all
      // sources, incl. out-of-band SR/IY that landed since), bump the dry streak.
      // Once it hits the limit the selector above backs the material off to a
      // weekly re-check instead of every window. A hard scout failure is NOT an
      // attempt: banking one silently parked every material for 6-12h during the
      // 2026-07-27 scout outage, which is how it went a week without being seen.
      //
      // A cycle where a scout PASS died is not a dry cycle. Rapeseed Fatty Acid
      // was demoted to a weekly re-check on 2026-08-11 having never once completed
      // a marketplace pass: three consecutive timeouts were counted as three
      // cycles of proof that the market was exhausted. The backoff still applies
      // (we do not hot-loop a broken scout), only the saturation verdict is
      // withheld. A failed INDEX source deliberately does not hold the streak:
      // SourceReady outages run for days, and holding on them would disable
      // saturation fleet-wide for the duration.
      if (isBacklogRescout && scoutRan && !scoutHardFailed) {
        const curCount = leadCount.get(material.id) ?? 0;
        const prevCount = lastAttemptCount.get(material.id);
        const prevDry = dryStreak.get(material.id) ?? 0;
        const grew = prevCount === undefined || curCount - prevCount >= DISCOVERY_MIN_NEW_PER_CYCLE;
        const nextDry = discoveryDegraded ? prevDry : grew ? 0 : prevDry + 1;
        if (discoveryDegraded) {
          await ctx.log(`${matLabel}: discovery degraded this cycle — holding dry streak at ${prevDry}`, {
            step: "backlog", data: { material_id: material.id, dry: prevDry, lead_count: curCount },
          });
        } else if (nextDry >= DISCOVERY_DRY_STREAK_LIMIT && nextDry !== prevDry) {
          await ctx.log(`${matLabel} saturated (${nextDry} dry cycles) — backing off to weekly re-check`, {
            step: "backlog", data: { material_id: material.id, dry: nextDry, lead_count: curCount },
          });
        }
        await admin.from("agent_state").upsert(
          {
            agent_id: ctx.agentId,
            key: BACKLOG_ATTEMPT_KEY(material.id),
            value: { at: new Date().toISOString(), count: curCount, dry: nextDry },
          },
          { onConflict: "agent_id,key" }
        );
      }

      if (stagedThisMaterial > 0) {
        materialsWithLeads++;
      } else {
        materialsWithoutLeads++;
        noLeadMaterials.push(matLabel);
        await ctx.log(`No candidates (graph or scout) for ${matLabel}`, {
          step: "candidates",
          data: { material_id: material.id, material_name: matLabel },
        });
      }
    }

    // Sourcing CSV of this run's new leads — for manual supplier-index upload.
    let csvUrl: string | null = null;
    try {
      const { data: runLeads } = await admin
        .from("leads_in_flight")
        .select("supplier_name, material_name, payload, source, confidence_score, stage")
        .eq("agent_run_id", ctx.runId);
      if (runLeads && runLeads.length) {
        const headers = ["kind", "supplier", "material", "inci", "role", "site_type", "country", "website", "email", "phone", "pricing", "moq", "grades", "certifications", "confidence", "source", "stage"];
        const rows: any[][] = runLeads.map((r: any) => {
          const p = r.payload ?? {};
          return [
            "lead", r.supplier_name ?? "", r.material_name ?? "", p.inci_name ?? "", p.supplier_role ?? "", p.site_type ?? "", p.supplier_country ?? "",
            p.supplier_website ?? p.source_url ?? "", p.supplier_contact_email ?? "", p.supplier_phone ?? "", p.pack_sizes_pricing ?? "", p.moq ?? "",
            p.grades_offered ?? "", p.certifications ?? "", r.confidence_score ?? "", r.source ?? "", r.stage ?? "",
          ];
        });

        // Ben's recco: append the saved quotes we already have for these materials
        // as context rows (kind=existing_quote) so the sourcing index shows what's
        // already covered — these are NOT new outreach leads.
        try {
          const quotes = await existingQuotesForMaterials(materials.map((m) => m.id));
          for (const q of quotes) {
            const priceLabel = q.price != null ? `$${q.price}${q.uom ? `/${q.uom}` : ""}${q.lead_time_days != null ? ` · lt ${q.lead_time_days}d` : ""}` : "";
            rows.push([
              "existing_quote", q.supplier_name ?? "", q.material_name ?? "", "", "", "", "",
              q.product_url ?? "", "", "", priceLabel, "", "", "", "", q.status ?? "quoted", "quoted",
            ]);
          }
          if (quotes.length) await ctx.log(`CSV: appended ${quotes.length} existing saved quote(s) as context`, { step: "csv" });
        } catch (e: any) {
          await ctx.log(`Existing-quotes lookup failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "csv" });
        }

        const filename = `${new Date().toISOString().slice(0, 10)}_new_leads_${runLeads.length}.csv`;
        const signed = await uploadCsvAndSign({ filename, content: toCsv(headers, rows), expiresInDays: 7 });
        csvUrl = signed.signedUrl;
        ctx.setMetadata({ csvSignedUrl: signed.signedUrl, csvFilename: filename, csvExpiresAt: signed.expiresAt });
        await ctx.log(`Sourcing CSV uploaded (${runLeads.length} leads) → ${signed.signedUrl}`, { step: "csv" });
      }
    } catch (e: any) {
      await ctx.log(`CSV build/upload failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "csv" });
    }

    await recordOrgRuns(admin, "agent-03-lead-creator", [...dueOaIds03]);
    ctx.setItemsProcessed(leadsCreated);
    const failedSources = [...sourceFailures.entries()];
    if (failedSources.length) {
      for (const [source, f] of failedSources) {
        await ctx.log(`Discovery source '${source}' failed on ${f.count} material(s): ${f.sample.slice(0, 200)}`, {
          level: "error",
          step: "sources",
          data: { source, materials: f.count },
        });
      }
    }
    ctx.setStatus(failedSources.length ? "partial" : "success");
    const graphLeads = leadsCreated - scoutLeadsCreated - reuseLeadsCreated;
    ctx.setSummary(
      `Staged ${leadsCreated} raw leads (${graphLeads} graph, ${scoutLeadsCreated} scout, ${reuseLeadsCreated} db-reuse) across ${materialsWithLeads} material${materialsWithLeads === 1 ? "" : "s"} · ` +
        `${materialsWithScoutLeads} got scout leads · ${materialsWithoutLeads} empty` +
        (skippedByExisting ? ` · ${skippedByExisting} skipped (already staged)` : "") +
        (skippedByName ? ` · ${skippedByName} skipped (same supplier already staged)` : "") +
        (skippedByExclusion ? ` · ${skippedByExclusion} skipped (do-not-contact / excluded country)` : "") +
        (internalParked ? ` · ${internalParked} internal material(s) parked (saturated)` : "") +
        (scoutEnabled ? "" : " · scout off (no ANTHROPIC_API_KEY)") +
        (failedSources.length
          ? ` · ⚠ SOURCE FAILED: ${failedSources.map(([s, f]) => `${s} (${f.count} material${f.count === 1 ? "" : "s"})`).join(", ")}`
          : "") +
        (scoutPassFailures ? ` · ${scoutPassFailures} scout pass(es) banked nothing` : "") +
        (csvUrl ? ` · CSV ready` : "") +
        (noLeadMaterials.length
          ? ` · empty: ${noLeadMaterials.slice(0, 3).join(", ")}${noLeadMaterials.length > 3 ? "…" : ""}`
          : "")
    );
  },
});
