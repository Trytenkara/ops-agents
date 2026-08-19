// Live FX → USD for marketplace prices listed in other currencies. Reads a
// free, no-key source (open.er-api.com, ECB-backed) and falls back to two
// independently operated mirrors. Rates are fetched once per process and cached,
// so a run that converts many prices makes at most one network call per source.
// Every table is validated before use (see validateRates): a source that answers
// but publishes stale or implausible numbers is treated as down, not as data.

let cache: { rates: Record<string, number>; fetchedAt: number; asOf: string | null; source: string } | null = null;
// Refetch when the snapshot is older than this, so a warm serverless instance
// doesn't keep serving a stale (day-old) rate. Date.now() is unavailable in some
// sandboxes; fall back to always-fresh if it throws.
// Shorter than the 6h FX-refresh cadence on purpose: a snapshot that expired at
// exactly the cadence boundary would let a warm instance restate prices against
// the rate the previous pass already used, so the "live" column wouldn't move.
const RATE_TTL_MS = 60 * 60 * 1000;
function nowMs(): number {
  try { return Date.now(); } catch { return 0; }
}

// Every writer of a converted price rounds identically, so a re-conversion at an
// unchanged rate is bit-for-bit stable and never reads as a price movement.
export function roundUsd(n: number): number {
  return Math.round(n * 100) / 100;
}
export function roundRate(r: number): number {
  return Math.round(r * 1e6) / 1e6;
}

// A rate table has to survive this before anything is priced off it. The old
// check was `typeof rates.USD === "number"`, which a source can satisfy while
// publishing garbage, and which said nothing about whether the numbers are
// current. Every non-USD price in the index rests on this, so the table is
// checked for shape, breadth, plausibility and age.
const MIN_CURRENCIES = 20;
// Weekend and holiday gaps are normal on ECB-backed feeds, so this is a "the
// source has stopped updating" alarm, not a freshness target.
const MAX_RATE_AGE_MS = 5 * 24 * 60 * 60 * 1000;
// Smoke test, not a market view: EUR has not left this band in the euro's
// lifetime, so a table outside it is inverted, mis-based or junk.
const EUR_PER_USD_BOUNDS: [number, number] = [0.5, 1.5];

function validateRates(rates: any, asOf: string | null): Record<string, number> | null {
  if (!rates || typeof rates !== "object") return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rates)) {
    const n = Number(v);
    if (typeof k === "string" && k.length === 3 && Number.isFinite(n) && n > 0) out[k.toUpperCase()] = n;
  }
  if (Object.keys(out).length < MIN_CURRENCIES) return null;
  // Base sanity: this table must be quoted per 1 USD.
  if (!(Math.abs((out.USD ?? 0) - 1) < 0.001)) return null;
  const eur = out.EUR;
  if (!eur || eur < EUR_PER_USD_BOUNDS[0] || eur > EUR_PER_USD_BOUNDS[1]) return null;
  if (asOf) {
    const t = Date.parse(asOf);
    const n = nowMs();
    if (Number.isFinite(t) && n > 0 && n - t > MAX_RATE_AGE_MS) return null;
  }
  return out;
}

// Both are key-free and independently operated. exchangerate.host was the second
// source until it moved behind an access key: it now answers 200 with
// {"success":false,"code":101}, which the old `res.ok` test read as reachable, so
// the fleet believed it had a fallback it had not had for months.
const SOURCES: { name: string; url: string; parse: (j: any) => { rates: any; asOf: string | null } }[] = [
  {
    name: "open.er-api.com",
    url: "https://open.er-api.com/v6/latest/USD",
    parse: (j) => ({
      rates: j?.rates,
      asOf: typeof j?.time_last_update_unix === "number" ? new Date(j.time_last_update_unix * 1000).toISOString() : null,
    }),
  },
  {
    name: "currency-api",
    // Publishes crypto tickers alongside ISO codes. Harmless here: a listing
    // quotes an ISO currency, and lookups are by exact code.
    url: "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
    parse: (j) => ({ rates: j?.usd, asOf: typeof j?.date === "string" ? `${j.date}T00:00:00Z` : null }),
  },
  {
    name: "currency-api (jsdelivr)",
    url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
    parse: (j) => ({ rates: j?.usd, asOf: typeof j?.date === "string" ? `${j.date}T00:00:00Z` : null }),
  },
];

// rates[CUR] = units of CUR per 1 USD (so 1 CUR = 1 / rates[CUR] USD).
async function loadUsdRates(): Promise<Record<string, number> | null> {
  const t = nowMs();
  if (cache && Object.keys(cache.rates).length && t > 0 && t - cache.fetchedAt < RATE_TTL_MS) {
    return cache.rates;
  }
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const { rates, asOf } = s.parse(await res.json());
      const clean = validateRates(rates, asOf);
      if (clean) {
        cache = { rates: clean, fetchedAt: nowMs(), asOf, source: s.name };
        return clean;
      }
    } catch {
      /* try next source */
    }
  }
  return null;
}

// Which source the live rates came from and how old they are, so a surface can
// say so instead of presenting a converted number with no provenance. Null until
// the first successful fetch in this process.
export function fxRateProvenance(): { source: string; asOf: string | null } | null {
  return cache ? { source: cache.source, asOf: cache.asOf } : null;
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
  return { usd: roundUsd(amount * rate), rate: roundRate(rate), currency: cur };
}

export interface FxSnapshot {
  // USD per 1 unit of `currency`. 1 for USD/blank, null when the source doesn't
  // publish that currency (caller must quarantine rather than guess).
  rateFor(currency: string | null | undefined): number | null;
  fetchedAt: string;
  // Which feed the table came from and the timestamp the feed itself published,
  // as opposed to when we read it. A restated price is only as current as this.
  source: string | null;
  asOf: string | null;
}

// One rate table for a whole pass. The 6h FX refresh restates thousands of
// stored native prices; it must use a SINGLE snapshot for all of them, otherwise
// rows converted early and late in the same pass carry different rates and the
// currency-vs-supplier delta split stops being reproducible.
export async function loadFxSnapshot(): Promise<FxSnapshot | null> {
  const rates = await loadUsdRates();
  if (!rates) return null;
  const prov = fxRateProvenance();
  return {
    fetchedAt: new Date().toISOString(),
    source: prov?.source ?? null,
    asOf: prov?.asOf ?? null,
    rateFor(currency) {
      const cur = (currency ?? "").trim().toUpperCase();
      if (!cur || cur === "USD") return 1;
      const perUsd = rates[cur];
      if (typeof perUsd !== "number" || perUsd <= 0) return null;
      return roundRate(1 / perUsd);
    },
  };
}

export interface UsdNormalization {
  // "usd": stated as USD — leave the number untouched.
  // "unknown": no currency stated at all. NOT the same as USD. Many suppliers
  //   quote in their domestic currency with no symbol, so assuming dollars here
  //   publishes a rupee figure as a dollar one. The caller must withhold the
  //   number and ask, never store it as USD.
  // "converted": a rate was found; `convert` restates any amount from the listed
  //   currency into USD, and `currency` is "USD".
  // "unconvertible": listed in a foreign currency but no rate is reachable — the
  //   caller MUST quarantine (flag needs_review) rather than let a raw foreign
  //   number render as USD. `convert` is identity and `currency` stays foreign.
  status: "usd" | "unknown" | "converted" | "unconvertible";
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
  if (!cur) {
    return {
      status: "unknown",
      currency: "",
      rate: null,
      note: "No currency stated on the quote; not stored as USD",
      convert: (n) => n,
    };
  }
  if (cur === "USD") {
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
    convert: (n) => (n == null || !Number.isFinite(n) ? n : roundUsd(n * rate)),
  };
}
