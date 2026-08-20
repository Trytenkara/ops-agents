// DATA-14: a captured price carries the words it was read from.
//
// The publish gate (price-publish.ts) checks the NUMBER: finite, positive, under
// ten million, in USD with conversion evidence. It cannot see that the number
// was never in the supplier's message. Katonah wrote "Drums are 518lbs at
// 1.1975/lb" and 620.5410 USD/lb was stored: the unit price multiplied by the
// drum weight, roughly 518x the real figure, and it passed every check we had
// because 620.54 is a perfectly plausible number. Four other rows held per-tonne
// prices (usd1280/mt) labelled per kg, for the same reason: nothing compared the
// stored unit against the words the unit came from.
//
// So the extractor now returns the fragment it read each price out of, and this
// verifies the claim rather than trusting it. A fabricated figure cannot produce
// a fragment containing itself, which is why this is a positive invariant and
// not a list of known-bad shapes (META-07: the next mistake will not be a
// multiplication, and a blocklist would not see it).
//
// Deliberately checks the price AS THE SUPPLIER STATED IT, before FX conversion.
// After conversion the stored number is ours, not theirs, and would never appear
// in their text.

export interface ProvenanceInput {
  /** The amount as the supplier wrote it, before any FX conversion. */
  price: number | null;
  /** The unit the extractor claims the price is in. */
  unitOfMeasurement: string | null;
  /** The verbatim fragment of the supplier's message the price was read from. */
  sourceText: string | null | undefined;
}

export interface ProvenanceResult {
  ok: boolean;
  /** Operator-readable reason, null when ok. */
  reason: string | null;
}

// Unit families, so "per kilo", "1000 kgs" and "kg" are the same claim and "mt"
// is not. Each family lists the spellings that may appear in a supplier's text.
// Order matters within the matcher: the longest spelling is tried first, so
// "metric ton" is not read as "ton" and "lbs" is not read as "lb" mid-word.
const UNIT_FAMILIES: Array<{ family: string; spellings: string[] }> = [
  { family: "tonne", spellings: ["metric tonne", "metric ton", "tonnes", "tonne", "mt", "ton", "tons"] },
  { family: "kg", spellings: ["kilograms", "kilogram", "kilos", "kilo", "kgs", "kg"] },
  { family: "lb", spellings: ["pounds", "pound", "lbs", "lb", "#"] },
  { family: "g", spellings: ["grams", "gram", "gm", "g"] },
  { family: "l", spellings: ["litres", "liters", "litre", "liter", "lt", "l"] },
  { family: "ml", spellings: ["millilitres", "milliliters", "ml"] },
  { family: "gal", spellings: ["gallons", "gallon", "gal"] },
  { family: "oz", spellings: ["ounces", "ounce", "oz"] },
  { family: "drum", spellings: ["drums", "drum"] },
  { family: "each", spellings: ["each", "unit", "units", "piece", "pieces", "pcs", "pc", "ea"] },
];

function unitFamily(raw: string | null | undefined): string | null {
  const u = (raw ?? "").toLowerCase().replace(/[^a-z#]/g, "");
  if (!u) return null;
  for (const { family, spellings } of UNIT_FAMILIES) {
    if (spellings.some((s) => s.replace(/[^a-z#]/g, "") === u)) return family;
  }
  return null;
}

/** Every unit family named anywhere in the supplier's fragment. */
function familiesPresent(text: string): Set<string> {
  const t = text.toLowerCase();
  const found = new Set<string>();
  for (const { family, spellings } of UNIT_FAMILIES) {
    for (const s of spellings) {
      // Word-boundary on both sides so "mt" does not match inside "amount" and
      // "l" does not match inside every word in the sentence. "#" has no word
      // boundary of its own, so it is matched literally.
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = s === "#" ? /#/ : new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, "i");
      if (re.test(t)) {
        found.add(family);
        break;
      }
    }
  }
  return found;
}

/** Numbers written in the fragment, with thousands separators removed. */
function numbersIn(text: string): Array<{ value: number; start: number; end: number }> {
  const out: Array<{ value: number; start: number; end: number }> = [];
  // 1,300 / 1300 / 1.1975 / .50 — the separator strip runs per match so a price
  // and a following sentence's figure are never fused into one number.
  //
  // The bare-decimal alternative may not follow a letter or a digit. Without
  // that, "Rs.230 per kg" is scanned left to right, the abbreviation dot starts
  // a match, and the Indian quote reads as 0.23 instead of 230 — a live case,
  // and one that would have withheld a correct price as unverifiable.
  for (const m of text.matchAll(/\d[\d,\s]*(?:\.\d+)?|(?<![A-Za-z\d])\.\d+/g)) {
    const n = Number(m[0].replace(/[,\s]/g, ""));
    if (Number.isFinite(n)) out.push({ value: n, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

// The unit that belongs to a price is the one written against it, not one
// mentioned elsewhere in the same sentence. "USD1450/MT FCA Qingdao, 215kg/drum"
// names three families; only the one next to 1450 is the basis, and a whole-
// fragment search would have accepted "kg" here and missed exactly the mislabel
// this guard exists to catch. Small window on purpose: a unit further away than
// this is describing something else.
const UNIT_WINDOW = 14;

/**
 * Does this stored price trace back to the supplier's own words?
 *
 * Withholding is the failure mode, never correction: this returns a reason and
 * the caller nulls the price and flags the row. It must not attempt to repair a
 * unit or recompute an amount, because a repaired number is still a number we
 * invented (DATA-01).
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

  // A relative tolerance, because "1.20" and 1.2 are the same claim and a
  // supplier may write 2,900.00 for 2900. Anything looser starts accepting a
  // neighbouring figure as evidence for the price.
  const hits = numbersIn(text).filter(
    (n) => Math.abs(n.value - input.price!) <= Math.abs(input.price!) * 1e-6 + 1e-9
  );
  if (!hits.length) {
    return {
      ok: false,
      reason: `price ${input.price} does not appear in the supplier's words ("${text.slice(0, 160)}"), so it was computed rather than read`,
    };
  }

  const claimed = unitFamily(input.unitOfMeasurement);
  // An unrecognised unit string is not a contradiction; the gap-reason path
  // already covers a missing basis, and inventing a rejection here would
  // withhold good prices quoted in units this list has never seen.
  if (claimed) {
    // Any occurrence of the figure may carry the unit, so the price is cleared
    // if ONE of them agrees. A ladder repeating the same amount is common and
    // the first occurrence is not privileged.
    const agrees = hits.some((h) => {
      const near = familiesPresent(
        text.slice(Math.max(0, h.start - UNIT_WINDOW), Math.min(text.length, h.end + UNIT_WINDOW))
      );
      // Nothing written against the number: fall back to the whole fragment, so
      // "we can do 1300 per tonne on that one" still verifies.
      const scope = near.size ? near : familiesPresent(text);
      return !scope.size || scope.has(claimed);
    });
    if (!agrees) {
      const named = [...familiesPresent(text)].join(", ");
      return {
        ok: false,
        reason: `unit "${input.unitOfMeasurement}" is not the basis the supplier wrote against this figure ("${text.slice(0, 160)}" names ${named}), so the basis was assumed rather than read`,
      };
    }
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
