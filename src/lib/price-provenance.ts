// DATA-14: a captured price is checked against the words it was read from.
//
// The publish gate (price-publish.ts) checks the NUMBER: finite, positive, under
// ten million, in USD with conversion evidence. It cannot see that the basis is
// wrong. Yujiang wrote "EXW price: USD1015/MT; Packing: 180KGS/Drum" and the row
// stored 1015 against a 180 kg case, making the material $5.64/kg instead of
// $1.015/kg — five and a half times too expensive, stamped `confidence: high`,
// because 1015 is a perfectly plausible number and nothing compared it to the
// basis the supplier actually quoted.
//
// What is NOT checked here, and why. An earlier version of this guard required
// the stored amount to appear verbatim in the supplier's text. That is wrong for
// this schema: `price` is the price of a CASE and `case_size` is how many units
// are in it, so a supplier quoting "518lbs at 1.1975/lb" correctly produces
// 620.31 — a number they never wrote. Requiring the literal amount withheld
// correct prices, and requiring the literal unit was worse: three correct rows
// quoting "USD 1,280/MT" against a 1000 kg case were rejected because the row
// says kg and the supplier wrote MT, which is the same basis in different words.
//
// So the invariant is arithmetic, not textual. Whatever the supplier quoted
// (amount A per unit G), the row's own per-unit price — price / case_size, in
// unit F — must agree with it once F and G are converted to common ground. That
// passes every legitimate way of writing the same offer and still catches a
// basis read off the packing line instead of the price line, which is the error
// that actually occurs (META-07: this is a property of the number, not a list of
// known-bad shapes).
//
// Deliberately checks the price AS THE SUPPLIER STATED IT, before FX conversion.
// After conversion the stored number is ours, not theirs.

export interface ProvenanceInput {
  /** The amount as the supplier wrote it, before any FX conversion. */
  price: number | null;
  /** The quantity that price covers. Null when the basis could not be read. */
  caseSize?: number | null;
  /** The unit `caseSize` is counted in. */
  unitOfMeasurement: string | null;
  /** The verbatim fragment of the supplier's message the price was read from. */
  sourceText: string | null | undefined;
}

export interface ProvenanceResult {
  ok: boolean;
  /** Operator-readable reason, null when ok. */
  reason: string | null;
}

// Unit families and their size in a base unit per dimension, so a price quoted
// per tonne can be compared with a row counted in kg. Families in a different
// dimension are not comparable, and a family with no scale ("drum", "each")
// is only ever comparable with itself.
const UNITS: Array<{ family: string; dim: string; scale: number; spellings: string[] }> = [
  { family: "tonne", dim: "mass", scale: 1000, spellings: ["metric tonnes", "metric tonne", "metric tons", "metric ton", "tonnes", "tonne", "mts", "mt", "tons", "ton"] },
  { family: "kg", dim: "mass", scale: 1, spellings: ["kilograms", "kilogram", "kilos", "kilo", "kgs", "kg"] },
  { family: "lb", dim: "mass", scale: 0.45359237, spellings: ["pounds", "pound", "lbs", "lb", "#"] },
  { family: "g", dim: "mass", scale: 0.001, spellings: ["grams", "gram", "gms", "gm", "g"] },
  { family: "oz", dim: "mass", scale: 0.028349523125, spellings: ["ounces", "ounce", "ozs", "oz"] },
  { family: "l", dim: "volume", scale: 1, spellings: ["litres", "liters", "litre", "liter", "lts", "lt", "l"] },
  { family: "ml", dim: "volume", scale: 0.001, spellings: ["millilitres", "milliliters", "mls", "ml"] },
  { family: "gal", dim: "volume", scale: 3.785411784, spellings: ["gallons", "gallon", "gals", "gal"] },
  { family: "drum", dim: "drum", scale: 1, spellings: ["drums", "drum"] },
  { family: "each", dim: "each", scale: 1, spellings: ["each", "units", "unit", "pieces", "piece", "pcs", "pc", "ea"] },
];

const BY_FAMILY = new Map(UNITS.map((u) => [u.family, u]));

function unitFamily(raw: string | null | undefined): string | null {
  const u = (raw ?? "").toLowerCase().replace(/[^a-z#]/g, "");
  if (!u) return null;
  for (const { family, spellings } of UNITS) {
    if (spellings.some((s) => s.replace(/[^a-z#]/g, "") === u)) return family;
  }
  return null;
}

/** Numbers written in the fragment, with thousands separators removed. */
function numbersIn(text: string): Array<{ value: number; end: number }> {
  const out: Array<{ value: number; end: number }> = [];
  // The bare-decimal alternative may not follow a letter or a digit. Without
  // that, "Rs.230 per kg" is scanned left to right, the abbreviation dot starts
  // a match, and the Indian quote reads as 0.23 instead of 230 — a live case,
  // and one that would have withheld a correct price as unverifiable.
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?|(?<![A-Za-z\d])\.\d+/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push({ value: n, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/**
 * The unit written immediately after a number: the "/MT" in "USD1280/MT", the
 * "kg" in "25800kg", the "per lb" in "1.20 per lb". Only what is written against
 * the figure counts — a unit further away is describing something else, which is
 * exactly how a packing line gets mistaken for a price basis.
 */
function unitAfter(text: string, from: number): string | null {
  const tail = text.slice(from, from + 16).toLowerCase();
  for (const { family, spellings } of UNITS) {
    for (const s of spellings) {
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`^[\\s/\\-.,]*(?:per\\s+)?${esc}(?![a-z])`).test(tail)) return family;
    }
  }
  return null;
}

/** Every (amount, unit) pair the supplier wrote in this fragment. */
function quotedRates(text: string): Array<{ amount: number; family: string }> {
  const out: Array<{ amount: number; family: string }> = [];
  for (const n of numbersIn(text)) {
    const f = unitAfter(text, n.end);
    if (f) out.push({ amount: n.value, family: f });
  }
  return out;
}

// One percent. Suppliers round their own arithmetic — Katonah's 518 lb drum at
// 1.1975/lb was stored as 620.5410 rather than 620.3050, a 0.04% drift — and a
// tolerance tighter than the rounding they do would withhold correct prices.
// Every real basis error seen is wrong by multiples, not by fractions.
const TOLERANCE = 0.01;

/**
 * Does this stored price agree with the price the supplier actually quoted?
 *
 * Withholding is the failure mode, never correction: this returns a reason and
 * the caller nulls the price and flags the row. It must not repair a unit or
 * recompute an amount, because a repaired number is still one we invented
 * (DATA-01).
 */
export function verifyPriceProvenance(input: ProvenanceInput): ProvenanceResult {
  // No price is not a provenance failure. A details-only reply legitimately has
  // nothing to trace, and PERS-07 already governs the withheld case.
  if (input.price == null) return { ok: true, reason: null };

  const text = (input.sourceText ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: `no source text: the extractor returned ${input.price} without the words it read it from, so the figure cannot be traced to anything the supplier wrote`,
    };
  }

  const rates = quotedRates(text);
  const claimed = unitFamily(input.unitOfMeasurement);
  const caseSize = input.caseSize ?? null;

  // Without a basis there is no per-unit price to compare, so fall back to the
  // weaker claim: the amount itself has to be somewhere in the supplier's words.
  // DATA-16 holds a basis-less rung for review regardless.
  if (caseSize == null || caseSize <= 0 || !claimed) {
    const appears = numbersIn(text).some(
      (n) => Math.abs(n.value - input.price!) <= Math.abs(input.price!) * TOLERANCE
    );
    return appears
      ? { ok: true, reason: null }
      : {
          ok: false,
          reason: `price ${input.price} does not appear in the supplier's words ("${text.slice(0, 160)}") and there is no basis to derive it from, so it was computed rather than read`,
        };
  }

  // A fragment that names no unit against any number cannot contradict the row.
  // Withholding here would reject every "we can do 4.53 on that one".
  if (!rates.length) {
    const appears = numbersIn(text).some(
      (n) => Math.abs(n.value - input.price!) <= Math.abs(input.price!) * TOLERANCE
    );
    return appears
      ? { ok: true, reason: null }
      : {
          ok: false,
          reason: `price ${input.price} does not appear in the supplier's words ("${text.slice(0, 160)}"), so it was computed rather than read`,
        };
  }

  const rowUnit = BY_FAMILY.get(claimed)!;
  const perClaimedUnit = input.price / caseSize;

  // The row agrees if ANY rate the supplier wrote is the same offer once the two
  // units are put on common ground. One match is enough: a fragment routinely
  // carries a packing weight and an order quantity alongside the price.
  const agrees = rates.some((r) => {
    const q = BY_FAMILY.get(r.family)!;
    if (q.dim !== rowUnit.dim) return false;
    const perQuotedUnit = perClaimedUnit * (q.scale / rowUnit.scale);
    return Math.abs(perQuotedUnit - r.amount) <= Math.abs(r.amount) * TOLERANCE;
  });

  if (!agrees) {
    const wrote = rates.map((r) => `${r.amount}/${r.family}`).join(", ");
    return {
      ok: false,
      reason: `the row works out to ${Number(perClaimedUnit.toPrecision(6))} per ${claimed}, which is not what the supplier quoted ("${text.slice(0, 160)}" states ${wrote}), so the basis was assumed rather than read`,
    };
  }

  return { ok: true, reason: null };
}

/**
 * Keying form of the fragment, used to tell two rungs of one ladder apart when
 * neither states a basis (DATA-16). Whitespace and case are normalised so an
 * echo of the same line in quoted history still collides, while a genuinely
 * different rung does not.
 */
export function provenanceKey(sourceText: string | null | undefined): string {
  return (sourceText ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
