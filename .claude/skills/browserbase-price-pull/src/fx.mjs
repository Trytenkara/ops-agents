// Live FX → USD for marketplace prices listed in other currencies. Mirrors the
// policy in ops-agents `src/lib/fx.ts`: convert foreign → USD when a rate is
// reachable, and QUARANTINE (never publish) when it isn't. The OA table also
// enforces this with a check constraint (leads_in_flight_marketplace_pull_usd),
// so an unconverted foreign price is rejected at write time.

let cache = null;
const RATE_TTL_MS = 12 * 60 * 60 * 1000;

// rates[CUR] = units of CUR per 1 USD (so 1 CUR = 1 / rates[CUR] USD).
//
// Single source on purpose. api.exchangerate.host used to serve as a keyless
// fallback but now answers HTTP 200 with {success:false, missing_access_key}, so
// it cannot satisfy the shape check below and only implied a redundancy that did
// not exist. Losing this source is not a correctness risk: no rate means the
// caller quarantines the price rather than publishing a foreign number as
// dollars. Do not add a replacement without confirming it returns rates
// unauthenticated.
const RATE_SOURCE = "https://open.er-api.com/v6/latest/USD";

async function loadUsdRates() {
  const t = Date.now();
  if (cache && t - cache.fetchedAt < RATE_TTL_MS) return cache.rates;
  try {
    const res = await fetch(RATE_SOURCE, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    const rates = j?.rates;
    // Shape-checked rather than trusting the status: the retired fallback proved
    // a 200 can still carry an error body with no rates on it.
    if (rates && typeof rates === "object" && typeof rates.USD === "number") {
      cache = { rates, fetchedAt: Date.now() };
      return rates;
    }
  } catch {
    /* unreachable or malformed — treated as no rate available */
  }
  return null;
}

export async function usdRateFor(currency) {
  const cur = (currency ?? "").trim().toUpperCase();
  if (!cur || cur === "USD") return null;
  const rates = await loadUsdRates();
  const perUsd = rates?.[cur];
  if (typeof perUsd !== "number" || perUsd <= 0) return null;
  return Math.round((1 / perUsd) * 1e6) / 1e6;
}

// Restate a pull result in USD. Returns the result unchanged when it is already
// USD or carries no price. When the listed currency has no reachable rate the
// result is downgraded to needs_review with the reason WHY, so the caller keeps
// any last-known good price instead of publishing a raw foreign number.
export async function normalizeResultToUsd(result) {
  const cur = (result.currency ?? "").trim().toUpperCase();
  if (result.current_price == null || !cur || cur === "USD") return result;

  const rate = await usdRateFor(cur);
  const conv = (n) => (n == null ? null : Math.round(n * rate * 100) / 100);

  if (rate == null) {
    return {
      ...result,
      classification: "needs_review",
      current_price: null,
      unit_price: null,
      tiers: [],
      notes: `listed in ${cur}; no USD rate reachable, quarantined rather than published unconverted. ${result.notes ?? ""}`.trim(),
    };
  }

  return {
    ...result,
    current_price: conv(result.current_price),
    unit_price: conv(result.unit_price ?? null),
    tiers: (result.tiers ?? []).map((t) => ({
      ...t,
      price: conv(t.price ?? null),
      unit_price: conv(t.unit_price ?? null),
    })),
    currency: "USD",
    original_currency: cur,
    fx_rate: rate,
    notes: `converted from ${cur} at 1 ${cur} = ${rate} USD. ${result.notes ?? ""}`.trim(),
  };
}
