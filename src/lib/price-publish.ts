// The last gate a price passes before it is stored.
//
// Two rules have never had a write-time home. "Never fabricate a price:
// unreadable means null plus the reason" lived as a sentence in each
// extractor's prompt, which is guidance to a model, not a constraint. "Never
// publish an unconverted foreign number" lived in whichever agent remembered to
// convert. price-qa.ts checks both, but it runs at READ time and cannot stop a
// bad number from being written, only describe it afterwards.
//
// This is deliberately a validator and not a reshaper. Each writer stores its
// own extra columns (FX provenance, previous prices, deltas), and a helper that
// rebuilt the object would quietly drop them, which is how sanitizeTiers came
// to be unusable on the main price path. Fields pass through untouched; only an
// unpublishable price is removed, and it is always replaced with a reason.

export interface PriceIssue {
  field: string;
  reason: string;
}

export interface PricedRow {
  price?: number | null;
  unit_price?: number | null;
  native_price?: number | null;
  native_currency?: string | null;
  currency?: string | null;
  fx_rate?: number | null;
  [key: string]: unknown;
}

function unusable(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return "not a finite number";
  if (n <= 0) return "zero or negative";
  // A price above this is a parse artefact every time we have seen it: a
  // concatenated phone number, an unconverted minor-unit amount, a quantity
  // read as a price. Cheaper to withhold and flag than to publish.
  if (n > 10_000_000) return "implausibly large";
  return null;
}

/**
 * Strip any price this row is not entitled to publish, and say why.
 *
 * A price is publishable when it is a sane positive number AND it is in USD,
 * either natively or with the conversion evidence (a foreign amount plus the
 * rate used) attached. A foreign amount with no rate is the exact shape that
 * once published yuan as dollars, so it is withheld rather than guessed at.
 */
export function publishablePrice<T extends PricedRow>(
  row: T,
  opts: { where?: string } = {}
): { row: T; issues: PriceIssue[] } {
  const issues: PriceIssue[] = [];
  const out: any = { ...row };

  const declared = (out.currency ?? "USD").toString().toUpperCase();
  const native = out.native_currency ? String(out.native_currency).toUpperCase() : null;
  // Number(null) is 0 and 0 is finite, so the rate has to be checked for being
  // present AND positive. Treating a missing rate as a valid one is precisely
  // the failure that published foreign amounts as dollars.
  const rate = out.fx_rate;
  const hasRate = rate != null && Number.isFinite(Number(rate)) && Number(rate) > 0;
  const converted = native && native !== "USD" ? hasRate : true;

  for (const field of ["price", "unit_price"]) {
    if (out[field] === null || out[field] === undefined) continue;
    const bad = unusable(out[field]);
    if (bad) {
      issues.push({ field, reason: bad });
      out[field] = null;
      continue;
    }
    if (declared !== "USD") {
      issues.push({ field, reason: `quoted in ${declared}, not converted to USD` });
      out[field] = null;
      continue;
    }
    if (!converted) {
      issues.push({ field, reason: `converted from ${native} with no FX rate recorded` });
      out[field] = null;
    }
  }

  if (issues.length) {
    const note = issues.map((i) => `${i.field} withheld (${i.reason})`).join("; ");
    out.price_withheld_reason = opts.where ? `${opts.where}: ${note}` : note;
  }
  return { row: out as T, issues };
}

/** Same gate across a tier ladder. Rungs left with no price at all are dropped. */
export function publishableTiers<T extends PricedRow>(
  tiers: T[] | null | undefined,
  opts: { where?: string } = {}
): { tiers: T[]; issues: PriceIssue[] } {
  const issues: PriceIssue[] = [];
  const kept: T[] = [];
  for (const [i, t] of (tiers ?? []).entries()) {
    const res = publishablePrice(t, { where: opts.where ? `${opts.where} tier ${i}` : `tier ${i}` });
    issues.push(...res.issues);
    // A rung that carried a price and lost it is no longer a price rung. Keeping
    // it as an empty row would read downstream as "this pack size is free".
    const hadPrice = t.price != null || t.unit_price != null;
    const hasPrice = res.row.price != null || res.row.unit_price != null;
    if (!hadPrice || hasPrice) kept.push(res.row);
  }
  return { tiers: kept, issues };
}
