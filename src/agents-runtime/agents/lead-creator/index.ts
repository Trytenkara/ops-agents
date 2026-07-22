import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { queryRecentMaterials, queryMaterialsByIds, queryMaterialsForOrgs, findCandidatesForMaterial, existingQuotesForMaterials, type CandidateSupplier, type MaterialRow } from "./sql";
import { scoutSuppliersForMaterial, scoreScoutConfidence, scoutCompleteness, type ScoutSupplier } from "./scout";
import { toCsv } from "@/lib/csv";
import { getSourcingExclusions, exclusionReason, type SourcingExclusions } from "@/lib/tenkara-sourcing-exclusions";
import { getNoteDerivedCountryExclusions } from "@/lib/client-sourcing-rules";
import { uploadCsvAndSign } from "@/lib/storage";
import { onlyOrgNames } from "@/lib/org-scope";
import { flagMaterialNames, correctName } from "@/lib/material-name-flags";
import { materialLabel } from "@/lib/material-label";

const EMPTY_OVERRIDES = new Map<string, string>();

// v1 trims (vs. full spec):
//   - existing-DB only mode. BrowserBase external discovery is gated on
//     BROWSERBASE_API_KEY; absent → we log and skip step 1b cleanly.
//   - dedup against lead_scanner_mirror over 90 days (per spec).
//   - cap 50 new leads per run.
//   - lookback window defaults to 4h but reads `last successful run` from
//     agent_runs so a missed cron doesn't drop materials.
// Override via env (LEAD_CREATOR_LOOKBACK_HOURS) for ops backfills or first-run
// testing — when set, takes precedence over the "since last successful run"
// logic. Production cron stays at the 4h cadence the spec asks for.
const DEFAULT_LOOKBACK_HOURS = 4;
const RECENT_MIRROR_DAYS = 90;
const MAX_NEW_LEADS_PER_RUN = 120;  // expansive runs: up to ~50 scout leads/material across marketplace + non-marketplace, plus graph leads

// Richness floor: a material is considered "needs sourcing" until it has this
// many active leads. Beyond the recency window, every run also pulls materials
// below the floor (0 leads = never sourced, or under-sourced) so nothing is ever
// stranded regardless of batch size — a self-draining work queue, no window
// dependency. Re-scouting an under-floor material is throttled per material by
// RESCOUT_BACKOFF (a marker in agent_state) so an expensive scout can't be
// re-run every tick on a material that simply has few suppliers to find.
const MIN_LEADS_PER_MATERIAL = envInt("LEAD_CREATOR_MIN_LEADS_PER_MATERIAL", 10);
const RESCOUT_BACKOFF_MS = envInt("LEAD_CREATOR_RESCOUT_BACKOFF_HOURS", 72) * 3600 * 1000;
const BACKLOG_ATTEMPT_KEY = (materialId: string) => `resource_attempt:${materialId}`;

function envInt(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

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
    const DRIVE_BUDGET_MS = 150_000;
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

    // 3. Pull recent mirror entries for dedup.
    const mirrorSince = new Date(Date.now() - RECENT_MIRROR_DAYS * 24 * 3600 * 1000).toISOString();
    const { data: mirrorRows } = await admin
      .from("lead_scanner_mirror")
      .select("supplier_name, material_name, uploaded_at")
      .gte("uploaded_at", mirrorSince);
    const mirrorPairs = new Set(
      (mirrorRows ?? []).map((r: any) =>
        `${(r.supplier_name ?? "").trim().toLowerCase()}|${(r.material_name ?? "").trim().toLowerCase()}`
      )
    );
    await ctx.log(`Loaded ${mirrorPairs.size} (supplier,material) mirror pairs for dedup`, { step: "dedup" });

    // 3b. Build Tenkara→OA org map (orgs.tenkara_org_id is the join key).
    //     Cached for the run so we make one round-trip total.
    const { data: orgRows } = await admin.from("orgs").select("id, tenkara_org_id, name");
    const tenkaraOrgToOaOrg = new Map<string, string>();
    const allowedTenkaraOrgIds = new Set<string>();
    const onlyOrgs = onlyOrgNames();
    for (const r of (orgRows ?? []) as { id: string; tenkara_org_id: string | null; name: string }[]) {
      if (r.tenkara_org_id) {
        tenkaraOrgToOaOrg.set(r.tenkara_org_id, r.id);
        if (onlyOrgs.length && onlyOrgs.includes(r.name)) allowedTenkaraOrgIds.add(r.tenkara_org_id);
      }
    }
    await ctx.log(`Loaded ${tenkaraOrgToOaOrg.size} tenkara→OA org mappings${onlyOrgs.length ? ` · scoped to ${onlyOrgs.join(", ")}` : ""}`, { step: "org_map" });

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
    if (!onlyMaterialId) {
      const targetTenkaraOrgIds = onlyOrgs.length
        ? Array.from(allowedTenkaraOrgIds)
        : Array.from(tenkaraOrgToOaOrg.keys());
      try {
        const universe = await queryMaterialsForOrgs(targetTenkaraOrgIds);
        // Paginate: Supabase caps a select at 1000 rows, and there are more than
        // 1000 active leads — an un-paginated fetch would undercount and falsely
        // mark materials as under-floor.
        const leadCount = new Map<string, number>();
        for (let from = 0; ; from += 1000) {
          const { data: rows } = await admin
            .from("leads_in_flight")
            .select("material_id")
            .eq("status", "active")
            .range(from, from + 999);
          const batch = (rows ?? []) as { material_id: string | null }[];
          for (const r of batch) if (r.material_id) leadCount.set(r.material_id, (leadCount.get(r.material_id) ?? 0) + 1);
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
            const at = Date.parse(m.value?.at ?? "");
            if (!Number.isNaN(at)) lastAttempt.set(m.key.slice("resource_attempt:".length), at);
          }
          if (batch.length < 1000) break;
        }
        const nowMs = Date.now();
        const already = new Set(materials.map((m) => m.id));
        const underserved = universe
          .filter((m) => (leadCount.get(m.id) ?? 0) < MIN_LEADS_PER_MATERIAL)
          .filter((m) => !already.has(m.id))
          .filter((m) => {
            const la = lastAttempt.get(m.id);
            return la === undefined || nowMs - la > RESCOUT_BACKOFF_MS;
          })
          .sort((a, b) =>
            (leadCount.get(a.id) ?? 0) - (leadCount.get(b.id) ?? 0) ||
            // created_at is a Date at runtime (pg driver), not the declared
            // string — compare by epoch so this works for either.
            (new Date(b.created_at as any).getTime() || 0) - (new Date(a.created_at as any).getTime() || 0)
          );
        const picked = underserved.slice(0, Math.max(0, 200 - materials.length));
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
        await ctx.log(
          `Backlog queue: ${underserved.length} materials below ${MIN_LEADS_PER_MATERIAL}-lead floor · sourcing ${picked.length} this run`,
          { step: "backlog", data: { below_floor: underserved.length, picked: picked.length } }
        );
      } catch (e: any) {
        await ctx.log(`Backlog queue query failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "backlog" });
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
    //     deterministic. The mirror check below is NOT sufficient: it only sees
    //     (supplier_name, material_name) pairs exported into lead_scanner_mirror
    //     by Agent 11, which is frequently empty (Agent 11 is off) — so it silently
    //     lets duplicates through. Guard directly against leads already in
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
    let materialsWithLeads = 0;
    let materialsWithoutLeads = 0;
    let materialsWithScoutLeads = 0;
    let skippedByMirror = 0;
    let skippedByExisting = 0;
    let skippedByExclusion = 0;
    const noLeadMaterials: string[] = [];

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
      // Fleet-wide org scoping: when ONLY_ORG is set, only source for materials
      // belonging to those orgs (matched via tenkara_org_id). Skip everything else.
      if (!onlyMaterialId && onlyOrgs.length && (!material.tenkara_org_id || !allowedTenkaraOrgIds.has(material.tenkara_org_id))) {
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
        const key = `${c.supplier_name.trim().toLowerCase()}|${matLabel.trim().toLowerCase()}`;
        if (mirrorPairs.has(key)) {
          skippedByMirror++;
          continue;
        }
        fresh.push(c);
      }
      if (unique.length > 0 && fresh.length === 0) {
        await ctx.log(`All ${unique.length} graph candidates for ${matLabel} skipped by 90d mirror dedup`, {
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
            supplier_website: c.supplier_website,
            supplier_contact_name: c.supplier_poc_name,
            supplier_contact_email: c.supplier_poc_email,
            supplier_country: c.supplier_country,
            signal: c.signal,
            signal_count: c.signal_count,
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

      // 5b. AI scout — runs whenever ANTHROPIC_API_KEY is set AND we haven't
      //     already produced scout leads for this material in a prior run
      //     (Ben's processed_material_ids equivalent). Dedups by host vs graph
      //     hits so we don't double-stage the same supplier.
      // Scout when there are no scout leads yet, OR when this material is a
      // backlog re-scout (below the richness floor and past its backoff window).
      const isBacklogRescout = underservedIds.has(material.id);
      if (scoutEnabled && leadsCreated < MAX_NEW_LEADS_PER_RUN && (!alreadyScouted.has(material.id) || isBacklogRescout)) {
        // Record the attempt up-front so a scout that surfaces nothing new still
        // backs off — it won't be re-run until RESCOUT_BACKOFF elapses.
        if (isBacklogRescout) {
          await admin.from("agent_state").upsert(
            { agent_id: ctx.agentId, key: BACKLOG_ATTEMPT_KEY(material.id), value: { at: new Date().toISOString() } },
            { onConflict: "agent_id,key" }
          );
        }
        // Exclude hosts we already have for this material (graph hits this run +
        // existing leads from prior runs) so a re-scout only adds NEW suppliers —
        // scout leads carry no supplier_id, so the graph dedup can't catch dupes.
        const excludeHosts = new Set<string>(graphHosts);
        for (const h of existingHostsByMaterial.get(material.id) ?? []) excludeHosts.add(h);
        let scoutResults: ScoutSupplier[] = [];
        try {
          scoutResults = await scoutSuppliersForMaterial(material, {
            excludeHosts,
            log: (msg, meta) => ctx.log(msg, { step: "scout", data: { ...meta, material_id: material.id } }),
          });
        } catch (e: any) {
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

        if (scoutAllowed.length > 0) {
          const scoutBudget = MAX_NEW_LEADS_PER_RUN - leadsCreated;
          const scoutToInsert = scoutAllowed.slice(0, scoutBudget).map((s) => ({
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
              supplier_website: s.url,
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
              site_type: s.site_type,            // M / MS / N — surfaced in UI
              confidence_hint: s.confidence_hint,
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

    ctx.setItemsProcessed(leadsCreated);
    ctx.setStatus("success");
    const graphLeads = leadsCreated - scoutLeadsCreated;
    ctx.setSummary(
      `Staged ${leadsCreated} raw leads (${graphLeads} graph, ${scoutLeadsCreated} scout) across ${materialsWithLeads} material${materialsWithLeads === 1 ? "" : "s"} · ` +
        `${materialsWithScoutLeads} got scout leads · ${materialsWithoutLeads} empty · ${skippedByMirror} graph candidates skipped by 90d mirror` +
        (skippedByExisting ? ` · ${skippedByExisting} skipped (already staged)` : "") +
        (skippedByExclusion ? ` · ${skippedByExclusion} skipped (do-not-contact / excluded country)` : "") +
        (scoutEnabled ? "" : " · scout off (no ANTHROPIC_API_KEY)") +
        (csvUrl ? ` · CSV ready` : "") +
        (noLeadMaterials.length
          ? ` · empty: ${noLeadMaterials.slice(0, 3).join(", ")}${noLeadMaterials.length > 3 ? "…" : ""}`
          : "")
    );
  },
});
