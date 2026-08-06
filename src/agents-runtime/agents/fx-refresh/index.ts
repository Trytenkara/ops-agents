import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshFxPrices } from "@/lib/fx-refresh";

// Agent 16 - FX Refresh.
//
// Restates stored USD prices for foreign-listed suppliers against the current
// exchange rate. No page reads, no model calls, no external cost beyond one rate
// fetch per run — it is arithmetic over native prices Agent 05 and Agent 08
// already captured.
//
// Why it is its own agent rather than a step inside Agent 05: the two have
// genuinely different economics. Re-reading a listing costs a model call and is
// capped at ~50 leads/run, so the scrape pool (1,200+ priced leads) can only
// just be cleared once a day. Re-converting costs nothing, so it can run every
// few hours across the whole corpus. Bolting this onto Agent 05 would have
// chained free work to an expensive run that is already at its deadline.
//
// OA-only. Reads leads_in_flight + staged_quotes, writes only the USD side of
// each (see the invariant in lib/fx-refresh.ts).

registerAgent({
  slug: "agent-16-fx-refresh",
  displayName: "Agent 16 - FX Refresh",
  description:
    "Recomputes published USD prices from stored native (listed-currency) prices at the current exchange rate, for marketplace/aggregator leads and pending staged quotes. Arithmetic only: no scraping, no LLM. Keeps the live price column current between Agent 05's daily page reads, and keeps currency movement separable from supplier repricing.",
  async run(ctx) {
    const admin = createAdminClient();
    const r = await refreshFxPrices(admin, ctx.log);

    if (!r.rateFetched) {
      ctx.setStatus("partial");
      ctx.setSummary("No FX rate source reachable; prices left at their last known rate.");
      return;
    }

    ctx.setItemsProcessed(r.leadsRestated + r.quotesRestated);
    ctx.setMetadata(r as any);
    ctx.setStatus(r.errors ? "partial" : "success");
    ctx.setSummary(
      `FX refresh: ${r.leadsRestated}/${r.leadsScanned} leads restated (${r.tiersRestated} tiers), ` +
        `${r.quotesRestated}/${r.quotesScanned} staged quotes` +
        (r.unknownCurrencies.length ? ` · no rate for ${r.unknownCurrencies.join(", ")}` : "") +
        (r.errors ? ` · ${r.errors} errors` : ""),
    );
  },
});
