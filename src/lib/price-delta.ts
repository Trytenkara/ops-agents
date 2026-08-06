// Splitting a price move into the part the seller caused and the part the
// exchange rate caused.
//
// Every published price in this system is USD, but a fifth of them were listed
// in something else (overwhelmingly INR, from IndiaMART/TradeIndia). For those,
// the USD figure moves for two independent reasons, and an operator looking at
// "$100 → $105" cannot act on it without knowing which:
//   - the seller repriced          → a sourcing signal, renegotiate or re-shop
//   - the rupee moved              → not the seller's doing, a hedging/timing signal
//
// Given a previous observation (n0 native units at rate f0 USD/unit) and a
// current one (n1 at f1), the USD move decomposes exactly:
//
//   usd1 - usd0  =  n1*f1 - n0*f0
//                =  n1*(f1 - f0)   +   (n1 - n0)*f0
//                   \___________/       \___________/
//                    currency delta       supplier delta
//
// The convention values the FX move at the CURRENT quantity and the seller's move
// at the OLD rate. Any split of a product of two changing terms has to assign the
// cross-term (Δn·Δf) to one side; putting it with the currency delta means that
// column answers "at what the seller is asking today, what is the rate costing
// me" — an operator reading it is deciding whether to buy now at a live price, so
// the live amount is the one worth denominating. The two parts always sum to the
// total, so the columns reconcile.

export type PriceChangeSource = "supplier" | "currency" | "both" | "none";

export interface PriceDeltaSplit {
  totalDelta: number | null;    // USD change, currency + supplier
  currencyDelta: number | null; // USD change attributable to the exchange rate
  supplierDelta: number | null; // USD change attributable to the seller repricing
  source: PriceChangeSource;
  // False when there is no native/rate pair on both sides — a USD-native listing
  // (where any move is by definition the seller's) or a legacy row written before
  // native capture. Callers should render the supplier column and leave the
  // currency column blank rather than implying a zero we did not measure.
  attributable: boolean;
}

export interface PriceObservation {
  usd: number | null;
  native: number | null;
  rate: number | null; // USD per 1 native unit
  currency: string | null;
}

// Below this, a component is noise (rounding, a rate wobbling in the sixth
// decimal) rather than a movement worth showing. Matches the 1% threshold the
// marketplace pull uses to decide a price "changed" at all.
const MATERIAL_PCT = 1.0;

const EMPTY: PriceDeltaSplit = {
  totalDelta: null,
  currencyDelta: null,
  supplierDelta: null,
  source: "none",
  attributable: false,
};

export function splitPriceDelta(prev: PriceObservation, cur: PriceObservation): PriceDeltaSplit {
  if (prev.usd == null || cur.usd == null || !Number.isFinite(prev.usd) || !Number.isFinite(cur.usd)) return EMPTY;
  const totalDelta = round(cur.usd - prev.usd);

  const pairable =
    prev.native != null &&
    cur.native != null &&
    prev.rate != null &&
    cur.rate != null &&
    prev.rate > 0 &&
    cur.rate > 0 &&
    // A listing that changed currency outright (site switched INR→USD) has no
    // meaningful decomposition; treat it as unattributable rather than inventing one.
    (prev.currency ?? "") === (cur.currency ?? "");

  if (!pairable) {
    // No native pair. For a USD listing that is not a gap: the seller IS the only
    // thing that can move the number, so attribute it entirely and say so.
    //
    // The currency must be stated explicitly on BOTH sides. Reading a null as
    // "USD" here would be the single most damaging default in this file: legacy
    // rows written before native capture also have null, and a foreign listing
    // among them would have its whole USD move reported as a supplier reprice
    // when the rate may have caused all of it. Unknown renders as unknown.
    const usdNative = prev.currency === "USD" && cur.currency === "USD";
    if (usdNative) {
      return {
        totalDelta,
        currencyDelta: 0,
        supplierDelta: totalDelta,
        source: materialAgainst(totalDelta, prev.usd) ? "supplier" : "none",
        attributable: true,
      };
    }
    return { ...EMPTY, totalDelta };
  }

  const currencyDelta = round(cur.native! * (cur.rate! - prev.rate!));
  const supplierDelta = round((cur.native! - prev.native!) * prev.rate!);

  const curMoved = materialAgainst(currencyDelta, prev.usd);
  const supMoved = materialAgainst(supplierDelta, prev.usd);
  const source: PriceChangeSource = supMoved && curMoved ? "both" : supMoved ? "supplier" : curMoved ? "currency" : "none";

  return { totalDelta, currencyDelta, supplierDelta, source, attributable: true };
}

function materialAgainst(delta: number | null, base: number): boolean {
  if (delta == null || base <= 0) return false;
  return Math.abs(delta) / base >= MATERIAL_PCT / 100;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Read a marketplace/aggregator price tier (leads_in_flight.payload.price_tiers)
// as a previous/current observation pair. Tiers store the raw inputs rather than
// a precomputed split so this stays the only place the convention lives.
export function tierDelta(tier: any): PriceDeltaSplit {
  if (!tier) return EMPTY;
  // No `?? "USD"` fallback: a tier with no recorded listing currency is one we
  // read before native capture shipped, and its currency is genuinely unknown.
  const currency = tier.native_currency ?? null;
  return splitPriceDelta(
    {
      usd: numOrNull(tier.previous_price),
      native: numOrNull(tier.previous_native_price),
      rate: numOrNull(tier.previous_fx_rate),
      currency,
    },
    {
      usd: numOrNull(tier.price),
      native: numOrNull(tier.native_price),
      rate: numOrNull(tier.fx_rate),
      currency,
    },
  );
}

function numOrNull(v: any): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Direct (supplier-quoted) prices.
//
// A marketplace tier compares one reading of a page to the previous reading of
// the same page, so both halves of the split share a baseline and reconcile to a
// single total. A supplier quote does not work that way, and forcing it into the
// same shape would produce a currency column that is always zero.
//
// The reason: the two questions have different baselines.
//   supplier delta — "is this supplier asking more than they asked last time?"
//                    compares two SEPARATE quote rows. Both float with the FX
//                    refresh, so by the time you compare them they are already
//                    valued at the same rate and the currency term cancels out.
//                    Which is correct: repricing between two quotes is entirely
//                    the seller's doing once you hold the rate constant.
//   currency delta — "is the quote I'm holding still worth what it was when it
//                    landed?" compares ONE row to its own capture-time anchor
//                    (captured_price / captured_fx_rate, frozen at insert).
//
// So they are two independent measures rather than an additive decomposition,
// and deliberately do not sum. Reporting a single "total" here would be a made-up
// number, so this returns no total at all.
export interface QuoteDeltaSplit {
  currencyDelta: number | null; // USD drift of this quote since it was captured
  supplierDelta: number | null; // USD move vs the previous quote, at a common rate
  source: PriceChangeSource;
  currencyAttributable: boolean;
  supplierAttributable: boolean;
}

export interface StagedQuoteObservation {
  price: number | null;
  native_price?: number | null;
  native_currency?: string | null;
  fx_rate?: number | null;
  captured_price?: number | null;
  captured_fx_rate?: number | null;
}

const EMPTY_QUOTE: QuoteDeltaSplit = {
  currencyDelta: null,
  supplierDelta: null,
  source: "none",
  currencyAttributable: false,
  supplierAttributable: false,
};

export function stagedQuoteDelta(
  cur: StagedQuoteObservation | null | undefined,
  prev: StagedQuoteObservation | null | undefined,
): QuoteDeltaSplit {
  if (!cur) return EMPTY_QUOTE;
  const curUsd = numOrNull(cur.price);
  const curNative = numOrNull(cur.native_price);
  const curRate = numOrNull(cur.fx_rate);
  const curCurrency = cur.native_currency ?? null;

  // Currency: this quote against its own frozen anchor. Only a foreign-quoted
  // row has drift; a USD quote is worth today exactly what it was worth then.
  let currencyDelta: number | null = null;
  let currencyAttributable = false;
  const anchor = numOrNull(cur.captured_price);
  if (curNative != null && curCurrency && curCurrency !== "USD" && anchor != null && curUsd != null) {
    currencyDelta = round(curUsd - anchor);
    currencyAttributable = true;
  } else if (curUsd != null && (!curCurrency || curCurrency === "USD")) {
    // Unlike a marketplace tier, a null here is safe to read as USD. The quote
    // writer has always recorded a conversion in extraction_notes, and no staged
    // quote has ever carried one (checked against the live table: every row is
    // USD-quoted). So there is no silent foreign legacy population to misattribute.
    currencyDelta = 0;
    currencyAttributable = true;
  }

  // Supplier: this quote against the previous one for the same supplier and
  // material. Value both sides at the current rate so a rate move between the
  // two quotes cannot masquerade as a reprice.
  let supplierDelta: number | null = null;
  let supplierAttributable = false;
  if (prev) {
    const prevNative = numOrNull(prev.native_price);
    const prevUsd = numOrNull(prev.price);
    const sameCurrency = (prev.native_currency ?? null) === curCurrency;
    if (prevNative != null && curNative != null && curRate != null && curRate > 0 && sameCurrency) {
      supplierDelta = round((curNative - prevNative) * curRate);
      supplierAttributable = true;
    } else if (prevUsd != null && curUsd != null && !curCurrency && !prev.native_currency) {
      // Both quoted in USD: the whole move is the seller's.
      supplierDelta = round(curUsd - prevUsd);
      supplierAttributable = true;
    }
  }

  const base = numOrNull(cur.captured_price) ?? curUsd ?? 0;
  const curMoved = currencyAttributable && materialAgainst(currencyDelta, base);
  const supMoved = supplierAttributable && materialAgainst(supplierDelta, base);
  const source: PriceChangeSource =
    supMoved && curMoved ? "both" : supMoved ? "supplier" : curMoved ? "currency" : "none";

  return { currencyDelta, supplierDelta, source, currencyAttributable, supplierAttributable };
}
