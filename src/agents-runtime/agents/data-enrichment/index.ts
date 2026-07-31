import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadOrgStatuses, sourcingAllowed } from "@/lib/org-status";
import { loadOrgTimingMap, filterDueOrgIds, recordOrgRuns } from "@/lib/org-tier";
import { assessMaterialRelevance, collectProductText, type RawLead } from "./enrich";
import { enrichAndStageLead } from "./run-enrich";
import { seedProfilesFromLeads } from "@/lib/supplier-profiles";
import { seedQuoteProfilesFromStaged, seedQuoteProfilesFromMarketplace } from "@/lib/quote-profiles";
import { loadMarketplaceCaseDims } from "@/lib/marketplace-case-dims";

// v1 trim (vs. full spec):
//   - pre-outreach only. Reply-driven enrichment lands when Agent 08
//     (Email Scanner) ships.
//   - cron-style sweep of stage='raw' & status='active' leads, ordered by
//     confidence_score DESC so the most promising candidates get enriched first.
//   - cap 25 leads/run. The probe step is network-bound (HEAD requests with
//     8s timeout each), so 25 keeps us comfortably under the 300s Vercel
//     Hobby maxDuration even in worst-case all-timeout scenarios.
const MAX_LEADS_PER_RUN = 25;

registerAgent({
  slug: "agent-06-enrichment",
  displayName: "Agent 06 - Data Enrichment",
  description:
    "Pre-outreach enrichment. Sweeps stage=raw leads, probes supplier website + contact email, merges Tenkara supplier metadata, then promotes to stage=enriched for human review.",
  async run(ctx) {
    const admin = createAdminClient();

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
    const QUOTE_SEED_CAP = 200;
    const MARKETPLACE_QUOTE_RESERVE = 50;
    let supplierBudget = SUPPLIER_SEED_CAP;
    let stagedQuoteBudget = QUOTE_SEED_CAP - MARKETPLACE_QUOTE_RESERVE;
    let marketplaceQuoteBudget = MARKETPLACE_QUOTE_RESERVE;
    let seededSuppliers = 0;
    let seededQuotes = 0;
    const { data: orgMeta } = await admin.from("orgs").select("id, is_internal").in("id", allSourcingOrgIds);
    const isInternalById = new Map((orgMeta ?? []).map((o: any) => [o.id, !!o.is_internal]));
    const seedOrder = [...allSourcingOrgIds].sort(
      (a, b) => Number(isInternalById.get(a) ?? false) - Number(isInternalById.get(b) ?? false)
    );
    // Case-dims cache is org-agnostic; load once and reuse for the marketplace seed.
    const caseDimsMap = allSourcingOrgIds.length ? await loadMarketplaceCaseDims(admin) : {};
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
          const n = await seedQuoteProfilesFromMarketplace(admin, orgId, caseDimsMap, marketplaceQuoteBudget);
          seededQuotes += n;
          marketplaceQuoteBudget -= n;
        }
      } catch (e: any) {
        await ctx.log(`Profile seed failed for org ${orgId}: ${e?.message ?? e}`, { level: "warn", step: "seed-profiles" });
      }
    }
    if (seededSuppliers || seededQuotes) {
      await ctx.log(`Seeded ${seededSuppliers} supplier + ${seededQuotes} quote profiles`, {
        step: "seed-profiles",
        data: { supplier_profiles: seededSuppliers, quote_profiles: seededQuotes },
      });
    }
    const seedNote = seededSuppliers || seededQuotes
      ? ` · seeded ${seededSuppliers} supplier + ${seededQuotes} quote profiles`
      : "";

    const timingMap06 = await loadOrgTimingMap(admin, "agent-06-enrichment", allSourcingOrgIds);
    const sourcingOrgIds = filterDueOrgIds(allSourcingOrgIds, timingMap06, "agent-06-enrichment");
    if (sourcingOrgIds.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary((allSourcingOrgIds.length ? "All orgs throttled by tier — not due yet." : "No orgs are active/sourcing_only — nothing to enrich.") + seedNote);
      return;
    }

    const { data: historical, error: historicalError } = await admin
      .from("leads_in_flight")
      .select("id, material_name, source, payload")
      .eq("status", "active")
      .in("stage", ["enriched", "ready_for_outreach"])
      .in("source", ["importyeti", "sourceready"])
      .in("org_id", sourcingOrgIds)
      .is("payload->enrichment->material_relevance", null)
      .order("created_at", { ascending: true })
      .limit(MAX_LEADS_PER_RUN);
    if (historicalError) {
      await ctx.log(`Historical relevance scan failed: ${historicalError.message}`, { level: "error", step: "relevance_backfill" });
    } else {
      for (const lead of historical ?? []) {
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

    // 1. Pull a batch of raw leads: never-attempted first, then whatever was tried
    //    longest ago, with confidence breaking ties inside each group.
    //
    //    Ordering on confidence alone deadlocked this sweep: a blocked lead stays at
    //    stage=raw and its score never moves, so once 25 of them collected at the top
    //    of a tier the same rows were re-selected every run and promotion sat at zero
    //    for days. The attempt timestamp is mutated by every attempt, so a lead
    //    physically cannot be re-selected ahead of untried work, and blocked leads
    //    come back for a retry only after the queue has cycled.
    const { data: leads, error: pullErr } = await admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_id, supplier_name, material_name, source, payload, confidence_score")
      .eq("stage", "raw")
      .eq("status", "active")
      .in("org_id", sourcingOrgIds)
      .order("last_enrichment_attempt_at", { ascending: true, nullsFirst: true })
      .order("confidence_score", { ascending: false, nullsFirst: false })
      .limit(MAX_LEADS_PER_RUN);

    if (pullErr) {
      await ctx.log(`Failed to pull raw leads: ${pullErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${pullErr.message}`);
      return;
    }

    if (!leads || leads.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No raw leads to enrich." + seedNote);
      return;
    }

    await ctx.log(`Enriching ${leads.length} raw leads`, { step: "pull", data: { count: leads.length } });

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
    const blockedReasons: Record<string, number> = {};
    const startedAt = Date.now();

    type LeadRow = { id: string; supplier_id: string | null; supplier_name: string | null; material_name: string | null; source: string | null; payload: any; confidence_score: number | null };
    async function processLead(row: LeadRow): Promise<void> {
      const lead: RawLead = {
        id: row.id,
        supplier_id: row.supplier_id,
        supplier_name: row.supplier_name,
        material_name: row.material_name,
        source: row.source,
        payload: row.payload ?? {},
        confidence_score: row.confidence_score,
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

    const CONCURRENCY = 5;
    const DEADLINE_MS = 230_000; // leave headroom under the 300s function limit
    for (let i = 0; i < leads.length; i += CONCURRENCY) {
      if (Date.now() - startedAt > DEADLINE_MS) {
        skipped = leads.length - i;
        await ctx.log(`Deadline reached — leaving ${skipped} leads at raw for the next run`, { step: "deadline" });
        break;
      }
      await Promise.all(leads.slice(i, i + CONCURRENCY).map(processLead));
    }

    await recordOrgRuns(admin, "agent-06-enrichment", sourcingOrgIds);
    ctx.setItemsProcessed(promoted + blocked);
    ctx.setStatus(errored > 0 && promoted + blocked === 0 ? "failure" : errored > 0 ? "partial" : "success");
    const reasonStr = Object.entries(blockedReasons)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    ctx.setSummary(
      `Enriched ${promoted}/${leads.length} → stage=enriched · ${blocked} left at raw${reasonStr ? ` (${reasonStr})` : ""}${skipped ? ` · ${skipped} deferred (deadline)` : ""}${superseded ? ` · ${superseded} superseded` : ""}${errored ? ` · ${errored} errors` : ""}${seedNote}`
    );
  },
});
