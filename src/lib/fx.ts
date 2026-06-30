// Live FX → USD for marketplace prices listed in other currencies. Uses a
// free, no-key rate source (open.er-api.com, ECB-backed) with a second source
// as fallback. Rates are fetched once per process and cached, so a run that
// converts many prices makes at most one network call per source.

let cache: { rates: Record<string, number>; fetchedAt: number } | null = null;

// rates[CUR] = units of CUR per 1 USD (so 1 CUR = 1 / rates[CUR] USD).
async function loadUsdRates(): Promise<Record<string, number> | null> {
  if (cache && Object.keys(cache.rates).length) return cache.rates;
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
        cache = { rates, fetchedAt: Date.now() };
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
