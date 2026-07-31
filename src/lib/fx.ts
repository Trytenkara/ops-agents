// Live FX → USD for marketplace prices listed in other currencies. Uses a
// free, no-key rate source (open.er-api.com, ECB-backed) with a second source
// as fallback. Rates are fetched once per process and cached, so a run that
// converts many prices makes at most one network call per source.

let cache: { rates: Record<string, number>; fetchedAt: number } | null = null;
// Refetch when the snapshot is older than this, so a warm serverless instance
// doesn't keep serving a stale (day-old) rate. Date.now() is unavailable in some
// sandboxes; fall back to always-fresh if it throws.
const RATE_TTL_MS = 12 * 60 * 60 * 1000;
function nowMs(): number {
  try { return Date.now(); } catch { return 0; }
}

// rates[CUR] = units of CUR per 1 USD (so 1 CUR = 1 / rates[CUR] USD).
async function loadUsdRates(): Promise<Record<string, number> | null> {
  const t = nowMs();
  if (cache && Object.keys(cache.rates).length && t > 0 && t - cache.fetchedAt < RATE_TTL_MS) {
    return cache.rates;
  }
  const sources = [
    { url: "https://open.er-api.com/v6/latest/USD", pick: (j: any) => j?.rates },
    { url: "https://api.exchangerate.host/latest?base=USD", pick: (j: any) => j?.rates },
  ];
  for (const s of sources) {
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j = await res.json();
      const rates = s.pick(j);
      if (rates && typeof rates === "object" && typeof rates.USD === "number") {
        cache = { rates, fetchedAt: nowMs() };
        return rates;
      }
    } catch {
      /* try next source */
    }
  }
  return null;
}

export interface UsdConversion {
  usd: number;       // amount converted to USD
  rate: number;      // 1 <currency> = <rate> USD
  currency: string;  // original currency code
}

// Convert an amount in `currency` to USD. Returns null for USD/empty/unknown
// currency or when no rate source is reachable (caller decides how to degrade).
export async function convertToUsd(amount: number | null, currency: string | null | undefined): Promise<UsdConversion | null> {
  if (amount == null || !Number.isFinite(amount)) return null;
  const cur = (currency ?? "").trim().toUpperCase();
  if (!cur || cur === "USD") return null;
  const rates = await loadUsdRates();
  if (!rates) return null;
  const perUsd = rates[cur];
  if (typeof perUsd !== "number" || perUsd <= 0) return null;
  const rate = 1 / perUsd; // USD per 1 unit of `cur`
  return { usd: Math.round(amount * rate * 100) / 100, rate: Math.round(rate * 1e6) / 1e6, currency: cur };
}

export interface UsdNormalization {
  // "usd": already USD (or blank, treated as USD) — leave the number untouched.
  // "converted": a rate was found; `convert` restates any amount from the listed
  //   currency into USD, and `currency` is "USD".
  // "unconvertible": listed in a foreign currency but no rate is reachable — the
  //   caller MUST quarantine (flag needs_review) rather than let a raw foreign
  //   number render as USD. `convert` is identity and `currency` stays foreign.
  status: "usd" | "converted" | "unconvertible";
  currency: string;                       // resulting currency label
  rate: number | null;                    // USD per 1 unit of the listed currency
  note: string | null;                    // human provenance note (null when USD)
  convert: (n: number | null) => number | null;
}

// Resolve one currency-normalization decision for a quoted price so every
// non-marketplace ingest path (staged-quote writer, supplier-reply capture)
// applies the SAME policy the marketplace pull uses: convert foreign → USD when
// a rate exists, and quarantine (not publish) when it doesn't. One rate lookup
// covers many amounts on the same quote (per-case price, unit price, tiers).
export async function normalizeToUsd(currency: string | null | undefined): Promise<UsdNormalization> {
  const cur = (currency ?? "").trim().toUpperCase();
  if (!cur || cur === "USD") {
    return { status: "usd", currency: "USD", rate: null, note: null, convert: (n) => n };
  }
  const probe = await convertToUsd(1, cur).catch(() => null);
  if (!probe) {
    return {
      status: "unconvertible",
      currency: cur,
      rate: null,
      note: `Listed in ${cur}; USD conversion unavailable — not publishing as USD`,
      convert: (n) => n,
    };
  }
  const rate = probe.rate; // USD per 1 unit of `cur`
  return {
    status: "converted",
    currency: "USD",
    rate,
    note: `Converted from ${cur} to USD @ ${rate}`,
    convert: (n) => (n == null || !Number.isFinite(n) ? n : Math.round(n * rate * 100) / 100),
  };
}
