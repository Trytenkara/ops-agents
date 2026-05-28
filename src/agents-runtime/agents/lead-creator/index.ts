import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { queryRecentMaterials, findCandidatesForMaterial, type CandidateSupplier, type MaterialRow } from "./sql";
import { scoutSuppliersForMaterial, scoreScoutConfidence, type ScoutSupplier } from "./scout";

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
const MAX_NEW_LEADS_PER_RUN = 50;

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

    // 2. Pull recent materials from Tenkara prod.
    let materials: MaterialRow[];
    try {
      materials = await queryRecentMaterials(since.toISOString());
    } catch (e: any) {
      await ctx.log(`Tenkara materials query failed: ${e.message}`, { level: "error", step: "query" });
      ctx.setStatus("failure");
      ctx.setSummary(`Failed at Tenkara materials query: ${e.message}`);
      return;
    }
    await ctx.log(`${materials.length} materials in window`, { step: "query", data: { count: materials.length } });

    if (materials.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No new materials in lookback window.");
      return;
    }

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
    const { data: orgRows } = await admin.from("orgs").select("id, tenkara_org_id");
    const tenkaraOrgToOaOrg = new Map<string, string>();
    for (const r of (orgRows ?? []) as { id: string; tenkara_org_id: string | null }[]) {
      if (r.tenkara_org_id) tenkaraOrgToOaOrg.set(r.tenkara_org_id, r.id);
    }
    await ctx.log(`Loaded ${tenkaraOrgToOaOrg.size} tenkara→OA org mappings`, { step: "org_map" });

    // 3c. Per-material idempotency for the scout phase. Equivalent to Ben's
    //     `processed_material_ids` set in sourcing-trigger.json — once a
    //     material has any scout-discovered lead, we don't re-scout it (the
    //     model would just re-find the same hosts and we'd waste API calls
    //     + risk duplicate inserts). Graph re-runs are still safe because
    //     they're keyed on Tenkara supplier_id, which is unique per material.
    const materialIds = materials.map((m) => m.id);
    const { data: scoutedRows } = await admin
      .from("leads_in_flight")
      .select("material_id")
      .eq("source", "ai_discovery")
      .in("material_id", materialIds);
    const alreadyScouted = new Set((scoutedRows ?? []).map((r: any) => r.material_id as string));
    if (alreadyScouted.size > 0) {
      await ctx.log(`${alreadyScouted.size} materials already have scout leads — skipping scout phase for them`, {
        step: "scout_dedup",
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
    const noLeadMaterials: string[] = [];

    for (const material of materials) {
      if (leadsCreated >= MAX_NEW_LEADS_PER_RUN) {
        await ctx.log(`Hit MAX_NEW_LEADS_PER_RUN=${MAX_NEW_LEADS_PER_RUN}; stopping`, { step: "cap" });
        break;
      }

      const matLabel = material.trade_name ?? material.name ?? material.id;
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

      // Mirror-based skip (supplier_name × material_name match).
      const fresh: CandidateSupplier[] = [];
      for (const c of unique) {
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

      // 5a. Stage graph-derived leads first (high confidence, deterministic).
      let stagedThisMaterial = 0;
      const graphHosts = new Set<string>();
      if (fresh.length > 0) {
        const budget = MAX_NEW_LEADS_PER_RUN - leadsCreated;
        const toInsert = fresh.slice(0, budget).map((c) => ({
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
        for (const c of fresh) {
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
      if (scoutEnabled && leadsCreated < MAX_NEW_LEADS_PER_RUN && !alreadyScouted.has(material.id)) {
        let scoutResults: ScoutSupplier[] = [];
        try {
          scoutResults = await scoutSuppliersForMaterial(material, {
            excludeHosts: graphHosts,
            log: (msg, meta) => ctx.log(msg, { step: "scout", data: { ...meta, material_id: material.id } }),
          });
        } catch (e: any) {
          await ctx.log(`Scout failed for ${matLabel}: ${e.message}`, {
            level: "warn",
            step: "scout",
            data: { material_id: material.id },
          });
        }

        if (scoutResults.length > 0) {
          const scoutBudget = MAX_NEW_LEADS_PER_RUN - leadsCreated;
          const scoutToInsert = scoutResults.slice(0, scoutBudget).map((s) => ({
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
              supplier_website: s.url,
              supplier_contact_email: s.email,
              supplier_country: s.country,
              site_type: s.site_type,            // M / MS / N — surfaced in UI
              confidence_hint: s.confidence_hint,
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

    ctx.setItemsProcessed(leadsCreated);
    ctx.setStatus("success");
    const graphLeads = leadsCreated - scoutLeadsCreated;
    ctx.setSummary(
      `Staged ${leadsCreated} raw leads (${graphLeads} graph, ${scoutLeadsCreated} scout) across ${materialsWithLeads} material${materialsWithLeads === 1 ? "" : "s"} · ` +
        `${materialsWithScoutLeads} got scout leads · ${materialsWithoutLeads} empty · ${skippedByMirror} graph candidates skipped by 90d mirror` +
        (scoutEnabled ? "" : " · scout off (no ANTHROPIC_API_KEY)") +
        (noLeadMaterials.length
          ? ` · empty: ${noLeadMaterials.slice(0, 3).join(", ")}${noLeadMaterials.length > 3 ? "…" : ""}`
          : "")
    );
  },
});
