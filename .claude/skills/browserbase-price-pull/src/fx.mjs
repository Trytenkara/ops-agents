// Listed-currency → USD for marketplace prices, holding the same policy as the
// fleet's src/lib/fx.ts: convert when a rate exists, and refuse to publish when
// one doesn't. The two implementations are separate because this skill runs as
// plain Node outside the Next app and cannot import its TypeScript modules; the
// invariant they both serve is enforced in the database
// (leads_in_flight_marketplace_pull_usd), so a drift between them fails loudly
// rather than publishing a foreign number labeled USD.
//
// Same keyless, ECB-backed sources as fx.ts, so both paths resolve the same rate
// for the same day. No new dependency; plain fetch.

let cache = null;
const RATE_TTL_MS = 12 * 60 * 60 * 1000;

// rates[CUR] = units of CUR per 1 USD, so 1 CUR = 1 / rates[CUR] USD.
async function loadUsdRates() {
  if (cache && Date.now() - cache.fetchedAt < RATE_TTL_MS) return cache.rates;
  const sources = [
    "https://open.er-api.com/v6/latest/USD",
    "https://api.exchangerate.host/latest?base=USD",
  ];
  for (const url of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const json = await res.json();
      const rates = json?.rates;
      if (rates && typeof rates === "object" && typeof rates.USD === "number") {
        cache = { rates, fetchedAt: Date.now() };
        return rates;
      }
    } catch {
      /* try the next source */
    }
  }
  return null;
}

/**
 * One rate decision for a whole pull, so a listing with a tier ladder costs a
 * single lookup and every number on it converts at the same rate.
 *
 * "usd"           — already USD, or unlabeled (treated as USD): leave untouched.
 * "converted"     — `rate` is USD per 1 unit of the listed currency.
 * "unconvertible" — foreign with no reachable rate. The caller MUST drop the
 *                   numbers; a raw foreign value rendered as "$" overstates by
 *                   the rate (₹149 as $149 is ~96x).
 */
export async function toUsdRate(currency) {
  const cur = (currency ?? "").trim().toUpperCase();
  if (!cur || cur === "USD") return { status: "usd", currency: "USD", rate: 1 };
  const rates = await loadUsdRates();
  const perUsd = rates?.[cur];
  if (typeof perUsd !== "number" || perUsd <= 0) {
    return { status: "unconvertible", currency: cur, rate: null };
  }
  return { status: "converted", currency: cur, rate: 1 / perUsd };
}

/** Restate one amount at a resolved rate, or pass through a null/non-finite. */
export function atRate(amount, rate) {
  if (amount == null || !Number.isFinite(amount)) return amount;
  return Math.round(amount * rate * 100) / 100;
}
