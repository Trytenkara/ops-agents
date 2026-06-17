import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { recheckMarketplaceQuote, type RecheckResult } from "./price-recheck";

// Agent 05 - Marketplace Price Re-check.
//
// Replaces the prior catalog-drift behavior. For each Tenkara marketplace
// quote that's expiring within 7 days, ask Anthropic (with web_search) to
// pull the current public price from the supplier's product page and write
// a finding to marketplace_check_findings for ops review.
//
// READ-ONLY on Tenkara. Findings get a status='pending_review' and stay
// there until a human approves or dismisses them in the UI. The approved
// rows are exported as a CSV that ops uploads to Tenkara manually - no
// auto-write-back to Tenkara prod.
//
// Slug stays 'agent-05-marketplace-validation' to keep agent_runs history
// continuous. The display name + description were updated in migration 0019.

const MAX_QUOTES_PER_RUN = 25;
const SIGNIFICANCE_THRESHOLD_PCT = 1.0; // <1% drift treated as unchanged

interface QuoteRow {
  id: string;                      // material_quotes.id
  material_id: string;
  material_name: string;
  supplier_id: string;
  supplier_name: string;
  price: number | null;
  case_size: number | null;
  unit_of_measurement: string | null;
  product_url: string;
  reanalyze: string | null;
  updated_at: string;
  tenkara_org_id: string | null;   // resolved via material -> user -> org
}

async function fetchExpiringMarketplaceQuotes(): Promise<QuoteRow[]> {
  return tenkaraQuery<QuoteRow>(
    `select mq.id,
            mq.material_id,
            m.name  as material_name,
            mq.supplier_id,
            s.name  as supplier_name,
            mq.price,
            mq.case_size,
            mq.unit_of_measurement,
            mq.product_url,
            mq.reanalyze::text as reanalyze,
            mq.updated_at::text as updated_at,
            u.organization_id   as tenkara_org_id
       from public.material_quotes mq
       join public.suppliers s on s.id = mq.supplier_id
       join public.materials m on m.id = mq.material_id
       left join public.users u on u.id = m.user_id
      where s.is_marketplace = true
        and mq.product_url is not null and mq.product_url <> ''
        and mq.product_url not ilike '%welcome.com%'
        and mq.product_url not ilike '%seed-suppliers.com%'
        and mq.product_url not ilike '%example.com%'
        and mq.product_url not ilike '%localhost%'
        and mq.product_url not ilike '%.invalid%'
        and length(regexp_replace(mq.product_url, '^https?://[^/]+', '')) > 1
        and mq.replaced_quote_id is null
        and mq.reanalyze is not null
        and mq.reanalyze::date >= current_date
        and mq.reanalyze::date <  current_date + 7
      order by mq.reanalyze asc
      limit $1`,
    [MAX_QUOTES_PER_RUN]
  );
}

function classify(baseline: number | null, current: number | null, result: RecheckResult): string {
  if (result.classification === "link_broken") return "link_broken";
  if (result.classification === "needs_review") return "needs_review";
  if (current == null) return "no_signal_found";
  if (baseline == null || baseline === 0) return "needs_review";
  const pct = ((current - baseline) / baseline) * 100;
  if (Math.abs(pct) < SIGNIFICANCE_THRESHOLD_PCT) return "signal_matches_baseline";
  return "signal_diverges";
}

registerAgent({
  slug: "agent-05-marketplace-validation",
  displayName: "Agent 05 - Marketplace Price Re-check",
  description:
    "Re-checks current public pricing on Tenkara marketplace quotes expiring within 7 days. Uses Anthropic web_search to find a current price signal per quote and writes findings to marketplace_check_findings for ops review. Read-only on Tenkara; never writes back.",
  async run(ctx) {
    const admin = createAdminClient();

    if (!process.env.ANTHROPIC_API_KEY) {
      await ctx.log("ANTHROPIC_API_KEY not set - cannot run price re-check", {
        level: "error",
        step: "config",
      });
      ctx.setStatus("failure");
      ctx.setSummary("ANTHROPIC_API_KEY missing");
      return;
    }

    let quotes: QuoteRow[];
    try {
      quotes = await fetchExpiringMarketplaceQuotes();
    } catch (e: any) {
      await ctx.log(`Tenkara quote query failed: ${e.message}`, { level: "error", step: "query" });
      ctx.setStatus("failure");
      ctx.setSummary(`Tenkara query failed: ${e.message}`);
      return;
    }
    await ctx.log(`Pulled ${quotes.length} expiring marketplace quotes`, { step: "query" });
    if (quotes.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No marketplace quotes expiring within 7 days.");
      return;
    }

    // Build Tenkara->OA org map so findings inherit the right org_id.
    const { data: orgRows } = await admin.from("orgs").select("id, tenkara_org_id");
    const tenkaraOrgToOaOrg = new Map<string, string>();
    for (const r of (orgRows ?? []) as { id: string; tenkara_org_id: string | null }[]) {
      if (r.tenkara_org_id) tenkaraOrgToOaOrg.set(r.tenkara_org_id, r.id);
    }

    // Skip quotes we already have a pending finding for - operators haven't acted on it yet.
    const quoteIds = quotes.map((q) => q.id);
    const { data: existing } = await admin
      .from("marketplace_check_findings")
      .select("quote_id, status")
      .in("quote_id", quoteIds)
      .eq("status", "pending_review");
    const pendingFor = new Set((existing ?? []).map((r: any) => r.quote_id));

    let written = 0;
    let skippedPending = 0;
    const counts = {
      signal_matches_baseline: 0,
      signal_diverges: 0,
      no_signal_found: 0,
      needs_review: 0,
      link_broken: 0,
    };

    for (const q of quotes) {
      if (pendingFor.has(q.id)) {
        skippedPending++;
        continue;
      }

      let result: RecheckResult;
      try {
        result = await recheckMarketplaceQuote({
          supplier_name: q.supplier_name,
          material_name: q.material_name,
          product_url: q.product_url,
          baseline_price: q.price,
          case_size: q.case_size,
          unit: q.unit_of_measurement,
        });
      } catch (e: any) {
        await ctx.log(`Re-check failed for quote ${q.id}: ${e.message}`, {
          level: "warn",
          step: "recheck",
          data: { quote_id: q.id, supplier: q.supplier_name, material: q.material_name },
        });
        result = {
          classification: "needs_review",
          current_price: null,
          pack_size: null,
          source_url: q.product_url,
          source_citations: [],
          notes: `Re-check failed: ${e.message}`,
        };
      }

      const oaOrgId = q.tenkara_org_id ? tenkaraOrgToOaOrg.get(q.tenkara_org_id) ?? null : null;
      const classification = classify(q.price, result.current_price, result);
      counts[classification as keyof typeof counts]++;

      // Prices that match baseline carry no signal — auto-resolve them so the
      // human review queue only holds actionable findings (diverges / needs_review
      // / link_broken). They stay in the table as a dismissed audit record.
      const autoResolved = classification === "signal_matches_baseline";

      const { error: insErr } = await admin.from("marketplace_check_findings").insert({
        org_id: oaOrgId,
        run_id: ctx.runId,
        quote_id: q.id,
        supplier_id: q.supplier_id,
        supplier_name: q.supplier_name,
        material_id: q.material_id,
        material_name: q.material_name,
        baseline_price: q.price,
        current_price: result.current_price,
        currency: "USD",
        pack_size: result.pack_size,
        classification,
        source_url: result.source_url,
        source_citations: result.source_citations,
        notes: result.notes,
        status: autoResolved ? "dismissed" : "pending_review",
        dismissed_at: autoResolved ? new Date().toISOString() : null,
      });

      if (insErr) {
        await ctx.log(`Insert finding failed for quote ${q.id}: ${insErr.message}`, {
          level: "error",
          step: "insert",
          data: { quote_id: q.id },
        });
        continue;
      }
      written++;
      await ctx.log(
        `${classification}: ${q.supplier_name} x ${q.material_name} (baseline=${q.price ?? "—"}, current=${result.current_price ?? "—"})`,
        { step: "finding", data: { quote_id: q.id, classification } }
      );
    }

    ctx.setItemsProcessed(written);
    ctx.setStatus("success");
    const interesting = counts.signal_diverges + counts.link_broken + counts.needs_review;
    ctx.setSummary(
      `Re-checked ${written} quotes (${interesting} need review) · ` +
        `${counts.signal_matches_baseline} unchanged · ${counts.signal_diverges} diverged · ` +
        `${counts.no_signal_found} no signal · ${counts.needs_review} needs review · ${counts.link_broken} link broken` +
        (skippedPending ? ` · ${skippedPending} skipped (already pending)` : "")
    );
  },
});
