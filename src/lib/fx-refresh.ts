import { loadFxSnapshot, roundUsd, type FxSnapshot } from "@/lib/fx";

// Restate stored USD prices against the current exchange rate, without reading
// a single web page.
//
// A foreign-listed price has two independent movers: the seller, and the rate.
// Re-reading the page is the only way to learn the first, and it is expensive
// (a model call + a fetch per lead, bounded by a per-run cap). The second is
// pure arithmetic over data we already hold, so it can run far more often for
// effectively nothing. That is the whole point of storing native price + rate:
// price freshness stops being coupled to scrape cost.
//
// THE INVARIANT THAT MAKES THE DELTA SPLIT WORK: this pass may only touch the
// CURRENT side of an observation — price, unit_price, fx_rate, fx_rate_at. It
// must never write native_price (nothing here learned what the seller is
// asking) and never write a baseline — previous_* on a lead belongs to the last
// actual page read, captured_* on a quote to the day it arrived. Move a baseline
// here and the currency delta silently resets to zero every pass, which is
// precisely the blindness this feature exists to fix.

const PAGE = 1000; // PostgREST caps a single select; page explicitly rather than silently truncating.

// Wider than Agent 05's 800s invocation deadline, so a lead written at the very
// start of a run that is still going is still considered in-flight.
const SCRAPE_QUIET_MS = 20 * 60 * 1000;

function recentlyScraped(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) && Date.now() - t < SCRAPE_QUIET_MS;
}

export interface FxRefreshResult {
  rateFetched: boolean;
  leadsScanned: number;
  leadsRestated: number;
  tiersRestated: number;
  quotesScanned: number;
  quotesRestated: number;
  unknownCurrencies: string[];
  errors: number;
}

export async function refreshFxPrices(admin: any, log: (m: string, o?: any) => Promise<void>): Promise<FxRefreshResult> {
  const result: FxRefreshResult = {
    rateFetched: false,
    leadsScanned: 0,
    leadsRestated: 0,
    tiersRestated: 0,
    quotesScanned: 0,
    quotesRestated: 0,
    unknownCurrencies: [],
    errors: 0,
  };

  const snapshot = await loadFxSnapshot();
  if (!snapshot) {
    // Both rate sources unreachable. Leave every stored price exactly as it is:
    // a stale USD figure from a known rate is honest, a guessed one is not.
    await log("FX refresh skipped: no rate source reachable. Prices left at their last known rate.", {
      level: "warn",
      step: "fx_refresh",
    });
    return result;
  }
  result.rateFetched = true;
  const unknown = new Set<string>();

  await refreshLeads(admin, snapshot, result, unknown, log);
  await refreshStagedQuotes(admin, snapshot, result, unknown, log);

  result.unknownCurrencies = [...unknown];
  if (unknown.size) {
    await log(`No published rate for: ${[...unknown].join(", ")}. Those prices were left untouched.`, {
      level: "warn",
      step: "fx_refresh",
    });
  }
  return result;
}

async function refreshLeads(
  admin: any,
  fx: FxSnapshot,
  result: FxRefreshResult,
  unknown: Set<string>,
  log: (m: string, o?: any) => Promise<void>,
): Promise<void> {
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await admin
      .from("leads_in_flight")
      .select("id, payload")
      .eq("status", "active")
      .eq("payload->marketplace_pull->>status", "pulled")
      .not("payload->marketplace_pull->>native_currency", "is", null)
      .range(from, from + PAGE - 1);
    if (error) {
      result.errors++;
      await log(`FX refresh lead page failed: ${error.message}`, { level: "error", step: "fx_refresh" });
      return;
    }
    if (!rows?.length) return;
    result.leadsScanned += rows.length;

    for (const row of rows) {
      const pull = row.payload?.marketplace_pull;
      const cur = pull?.native_currency;
      if (!cur || cur === "USD") continue;
      // Both this pass and Agent 05 overwrite the whole `payload` jsonb, so an
      // interleave (we read, Agent 05 writes a fresh scrape, we write our stale
      // copy back) would silently discard a real page read. Leave anything Agent
      // 05 touched recently alone: it was just scraped, so its price already
      // reflects a current rate and there is nothing here to add. Costs one
      // skipped restatement and removes the whole lost-update class.
      if (recentlyScraped(row.payload?.price_tiers_updated_at)) continue;
      const rate = fx.rateFor(cur);
      if (rate == null) {
        unknown.add(cur);
        continue;
      }

      const nextPull = { ...pull };
      let touched = false;
      if (typeof pull.native_price === "number") {
        const restated = roundUsd(pull.native_price * rate);
        if (restated !== pull.price) touched = true;
        nextPull.price = restated;
      }
      if (typeof pull.native_unit_price === "number") {
        nextPull.unit_price = roundUsd(pull.native_unit_price * rate);
      }
      nextPull.fx_rate = rate;
      nextPull.fx_rate_at = fx.fetchedAt;
      // Say plainly that no page was read. Without this the price looks freshly
      // observed, and an operator would read a restated number as evidence the
      // seller is still asking it.
      nextPull.price_source = "fx_refresh";
      nextPull.price_source_at = fx.fetchedAt;
      // Nothing here reads a page, so any move this pass makes is the rate and
      // only the rate. Stating that explicitly is what lets a consumer skip
      // reissuing a quote: the seller is still asking the same native amount.
      if (touched) {
        nextPull.price_change_source = "currency";
        nextPull.currency_delta_usd = roundUsd(nextPull.price - (typeof pull.price === "number" ? pull.price : nextPull.price));
        nextPull.supplier_delta_usd = 0;
      }

      const tiers = Array.isArray(row.payload?.price_tiers) ? row.payload.price_tiers : [];
      let tiersTouched = 0;
      const nextTiers = tiers.map((t: any) => {
        if (typeof t?.native_price !== "number" || !t.native_currency || t.native_currency === "USD") return t;
        const tRate = fx.rateFor(t.native_currency);
        if (tRate == null) {
          unknown.add(t.native_currency);
          return t;
        }
        const price = roundUsd(t.native_price * tRate);
        if (price !== t.price) tiersTouched++;
        return {
          ...t,
          price,
          unit_price: typeof t.native_unit_price === "number" ? roundUsd(t.native_unit_price * tRate) : t.unit_price,
          fx_rate: tRate,
          price_source: "fx_refresh",
          price_source_at: fx.fetchedAt,
          ...(price !== t.price
            ? { price_change_source: "currency", currency_delta_usd: roundUsd(price - t.price), supplier_delta_usd: 0 }
            : {}),
        };
      });

      if (!touched && !tiersTouched) continue;

      const { error: upErr } = await admin
        .from("leads_in_flight")
        .update({ payload: { ...row.payload, marketplace_pull: nextPull, price_tiers: nextTiers } })
        .eq("id", row.id);
      if (upErr) {
        result.errors++;
        continue;
      }
      result.leadsRestated++;
      result.tiersRestated += tiersTouched;
    }
    if (rows.length < PAGE) return;
  }
}

async function refreshStagedQuotes(
  admin: any,
  fx: FxSnapshot,
  result: FxRefreshResult,
  unknown: Set<string>,
  log: (m: string, o?: any) => Promise<void>,
): Promise<void> {
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await admin
      .from("staged_quotes")
      .select("id, price, native_price, native_currency, fx_rate")
      // Only rows still in review. An approved quote is a number an operator
      // signed off and downstream treats as agreed; silently restating it later
      // would change a commercial figure behind their back.
      .eq("status", "pending_review")
      .not("native_currency", "is", null)
      .range(from, from + PAGE - 1);
    if (error) {
      result.errors++;
      await log(`FX refresh staged-quote page failed: ${error.message}`, { level: "error", step: "fx_refresh" });
      return;
    }
    if (!rows?.length) return;
    result.quotesScanned += rows.length;

    for (const q of rows) {
      if (!q.native_currency || q.native_currency === "USD" || typeof q.native_price !== "number") continue;
      const rate = fx.rateFor(q.native_currency);
      if (rate == null) {
        unknown.add(q.native_currency);
        continue;
      }
      const price = roundUsd(q.native_price * rate);
      if (price === q.price) continue;
      const { error: upErr } = await admin
        .from("staged_quotes")
        .update({
          price,
          fx_rate: rate,
          fx_rate_at: fx.fetchedAt,
          price_source: "fx_refresh",
          price_source_at: fx.fetchedAt,
          price_change_source: "currency",
          currency_delta_usd: roundUsd(price - Number(q.price ?? price)),
          supplier_delta_usd: 0,
        })
        .eq("id", q.id);
      if (upErr) {
        result.errors++;
        continue;
      }
      result.quotesRestated++;
    }
    if (rows.length < PAGE) return;
  }
}
