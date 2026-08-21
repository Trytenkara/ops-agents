// DATA-14/DATA-15, the backward half.
//
// The capture-time gate cannot reach a row captured before it existed, and the
// California Chemicals audit that found the first bad row was a person reading
// 77 email threads by hand. That does not scale and it does not repeat.
//
// The audit's own conclusion was that a stored row cannot be rechecked because
// it does not carry the supplier's words. That is only half true: it does not
// carry the message, but every row carries `raw_extract`, the model's own
// reading of it — including the unit the price was stated in and the packing it
// named. Reconciling the stored columns against that reading needs no message,
// no model call and no network, and it caught the one wrong row fleet-wide out
// of 106 priced rows on the first pass.
//
// It cannot see a price that was never extracted at all; that is Agent 24's
// forward half, which counts what a message states before anything reads it.

export interface ReconcilableQuote {
  price: number | string | null;
  case_size: number | string | null;
  unit_of_measurement: string | null;
  currency: string | null;
  unit_price: number | string | null;
  native_price: number | string | null;
  native_currency: string | null;
  fx_rate: number | string | null;
  raw_extract: unknown;
}

const TONNE_UNITS = new Set(["mt", "t", "tm", "ton", "tonne", "tonnes", "metric ton"]);
const KG_UNITS = new Set(["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"]);
const LB_UNITS = new Set(["lb", "lbs", "pound", "pounds"]);
const KG_PER_TONNE = 1000;
const LB_PER_TONNE = 2204.62;

/**
 * How many tonnes one case holds, or null if the case is measured in something
 * that is not a weight. A volume case cannot be priced off a per-tonne figure
 * without a density, and assuming one is how a basis gets lost, so the caller
 * reports those rather than converting them.
 */
export function caseInTonnes(caseSize: number, unit: string | null): number | null {
  const u = String(unit ?? "").trim().toLowerCase();
  if (KG_UNITS.has(u)) return caseSize / KG_PER_TONNE;
  if (LB_UNITS.has(u)) return caseSize / LB_PER_TONNE;
  if (TONNE_UNITS.has(u)) return caseSize;
  return null;
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rawObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

function off(a: number, b: number) {
  return Math.abs(a - b) > Math.max(0.01, Math.abs(a) * 0.01);
}

/**
 * What the case should cost if the extract is read the way the supplier meant
 * it. Usually the extracted figure itself; for a price quoted per tonne against
 * a case that is not a tonne, the figure scaled to the case.
 *
 * Returns null when the extract does not say enough to expect anything, which
 * is not a finding — an unknown is not a defect.
 */
export function expectedCasePrice(row: ReconcilableQuote): { value: number | null; note: string | null } {
  const raw = rawObject(row.raw_extract);
  const rawPrice = num(raw.price as never);
  if (rawPrice === null) return { value: null, note: null };

  const rawUnit = String((raw.unit_of_measurement as string) ?? "").trim().toLowerCase();
  const caseSize = num(row.case_size);
  if (!TONNE_UNITS.has(rawUnit) || caseSize === null) return { value: rawPrice, note: null };

  const tonnes = caseInTonnes(caseSize, row.unit_of_measurement);
  if (tonnes === null) {
    return {
      value: null,
      note:
        `the price is stated per ${rawUnit.toUpperCase()} but the case is measured in ` +
        `${row.unit_of_measurement ?? "no unit at all"}, so nothing can convert one to the other without a density`,
    };
  }
  return { value: rawPrice * tonnes, note: null };
}

export function reconcileQuoteRow(row: ReconcilableQuote): string[] {
  const issues: string[] = [];
  const price = num(row.price);
  if (price === null) return issues;

  const caseSize = num(row.case_size);
  const unitPrice = num(row.unit_price);

  if (caseSize !== null && caseSize !== 0 && unitPrice !== null && off(price / caseSize, unitPrice)) {
    issues.push(`unit price ${unitPrice} is not price ${price} over case ${caseSize}`);
  }

  const nativePrice = num(row.native_price);
  const fxRate = num(row.fx_rate);
  const nativeCurrency = String(row.native_currency ?? "").trim().toUpperCase();
  const currency = String(row.currency ?? "").trim().toUpperCase();
  const converted = nativeCurrency !== "" && nativeCurrency !== "USD" && fxRate !== null;

  if (converted && nativePrice !== null && off(nativePrice * (fxRate as number), price)) {
    issues.push(
      `${nativePrice} ${nativeCurrency} at ${fxRate} is ${(nativePrice * (fxRate as number)).toFixed(4)}, not the stored ${price}`
    );
  }

  // The figure to compare is the pre-conversion one when a conversion happened,
  // because that is the number the extractor read.
  const asRead = converted && nativePrice !== null ? nativePrice : price;
  const expected = expectedCasePrice(row);
  if (expected.note) issues.push(expected.note);
  else if (expected.value !== null && off(expected.value, asRead)) {
    const raw = rawObject(row.raw_extract);
    const rawUnit = String((raw.unit_of_measurement as string) ?? "").trim().toUpperCase();
    const stated = num(raw.price as never);
    issues.push(
      rawUnit && TONNE_UNITS.has(rawUnit.toLowerCase())
        ? `supplier stated ${stated} per ${rawUnit} against a ${caseSize} ${row.unit_of_measurement ?? ""} case, ` +
          `which is ${expected.value.toFixed(4)} for the case, not the stored ${asRead}`
        : `stored price ${asRead} does not match the extracted ${stated}`
    );
  }

  const rawCurrency = String((rawObject(row.raw_extract).currency as string) ?? "").trim().toUpperCase();
  if (!converted && rawCurrency && currency && rawCurrency !== currency) {
    issues.push(`stored currency ${currency} does not match the extracted ${rawCurrency} and no conversion is recorded`);
  }

  return issues;
}
