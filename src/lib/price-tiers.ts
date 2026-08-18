// Tier pricing for marketplace leads — published price ladders captured off a
// supplier's own website (volume breaks). Stored on leads_in_flight.payload as
// `price_tiers`. Mirrors the PriceTier shape Agent 05 already uses for Tenkara
// marketplace re-checks, so the two can converge later.

export interface PriceTier {
  pack_size: string | null; // free-text, e.g. "25 kg drum", "1 lb"
  price: number | null; // total price for that pack, in USD
  unit_price: number | null; // per-unit price ($/kg, $/lb…) when derivable
  // Structured breakdown of pack_size, matching the Tenkara quote columns so the
  // marketplace export populates the platform directly. Optional: agents write
  // only pack_size; these are filled when an operator edits the split cells, and
  // otherwise derived on read via parsePackSize().
  case_size?: number | null; // units per case, e.g. 55
  unit_of_measurement?: string | null; // kg, lb, g, L, oz, ml, gal, ton…
  case_type?: string | null; // container / packaging, e.g. drum, pail, bag
  // Shipping cost estimate for this tier in USD. For the MOQ tier (index 0),
  // this is the actual cost captured from checkout; for other tiers, it is
  // model-estimated based on weight/volume ratios. Null if not available.
  shipping_cost_estimate?: number | null;
}

// Unit tokens → the canonical unit_of_measurement string Tenkara expects.
const UNIT_CANON: Record<string, string> = {
  kg: "kg", kgs: "kg", kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg",
  g: "g", gram: "g", grams: "g", gm: "g", gms: "g",
  mg: "mg",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  oz: "oz", ounce: "oz", ounces: "oz",
  mt: "ton", ton: "ton", tons: "ton", tonne: "ton", tonnes: "ton", metricton: "ton",
  l: "L", liter: "L", liters: "L", litre: "L", litres: "L", ltr: "L", ltrs: "L",
  ml: "ml",
  gal: "gal", gallon: "gal", gallons: "gal",
  ea: "ea", each: "ea", unit: "unit", units: "unit",
  ct: "ct", count: "ct", pc: "pc", pcs: "pc", piece: "pc", pieces: "pc",
};

// Container / packaging words that map to case_type (free text in Tenkara).
const CONTAINERS = [
  "drum", "pail", "bottle", "jug", "tote", "bag", "sack", "box", "carton", "case",
  "bucket", "can", "jar", "bin", "tube", "tub", "pouch", "packet", "barrel", "keg",
  "canister", "vial", "sachet", "cup",
];

function parseQty(raw: string): number | null {
  const s = raw.replace(/,/g, "").trim();
  const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/); // "1 1/2"
  if (mixed) {
    const d = Number(mixed[3]);
    return d ? Number(mixed[1]) + Number(mixed[2]) / d : null;
  }
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/); // "1/4"
  if (frac) {
    const d = Number(frac[2]);
    return d ? Number(frac[1]) / d : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Split a free-text pack-size ("25 kg drum", "7 LB Bottle", "1/4 lb") into the
// structured Tenkara columns. Never guesses: an unrecognized unit/container
// yields null for that field rather than a made-up value.
export function parsePackSize(packSize: string | null | undefined): {
  case_size: number | null;
  unit_of_measurement: string | null;
  case_type: string | null;
} {
  const empty = { case_size: null, unit_of_measurement: null, case_type: null };
  if (!packSize || typeof packSize !== "string") return empty;
  // Drop parentheticals like "(2.2 lb)" / "(upper range)" so they don't pollute parsing.
  let s = packSize.replace(/\([^)]*\)/g, " ").trim();
  // A leading comparator is a MOQ phrasing (">=1000 kilograms"), not part of the
  // quantity, so strip it or the pack reads as unknown.
  s = s.replace(/^\s*(?:>=|<=|≥|≤|>|<|~|±|approx\.?|about|min\.?|minimum)\s*/i, "").trim();
  if (!s) return empty;

  // "Per Kg" / "/lb" quote the price for ONE unit. That is a pack size of 1, and
  // the most comparable form there is; reading it as unknown loses a good quote.
  const perUnit = s.match(/^(?:per\s+|\/\s*)([a-zA-Z]+)\b/i);
  if (perUnit) {
    const canon = UNIT_CANON[perUnit[1].toLowerCase()];
    if (canon) {
      let case_type: string | null = null;
      const lower = packSize.toLowerCase();
      for (const c of CONTAINERS) {
        if (new RegExp(`\\b${c}s?\\b`, "i").test(lower)) { case_type = c; break; }
      }
      return { case_size: 1, unit_of_measurement: canon, case_type };
    }
  }

  let case_size: number | null = null;
  let rest = s;
  const qtyMatch = s.match(/^\s*(\d[\d,]*(?:\.\d+)?\s*\/\s*\d+|\d+\s+\d+\s*\/\s*\d+|\d[\d,]*(?:\.\d+)?)/);
  if (qtyMatch) {
    case_size = parseQty(qtyMatch[1]);
    rest = s.slice(qtyMatch[0].length);
  }

  let unit_of_measurement: string | null = null;
  const unitMatch = rest.match(/^\s*([a-zA-Z]+)/);
  if (unitMatch) {
    const canon = UNIT_CANON[unitMatch[1].toLowerCase()];
    if (canon) unit_of_measurement = canon;
  }

  let case_type: string | null = null;
  const lower = s.toLowerCase();
  for (const c of CONTAINERS) {
    if (new RegExp(`\\b${c}s?\\b`, "i").test(lower)) {
      case_type = c;
      break;
    }
  }

  return { case_size, unit_of_measurement, case_type };
}

// The structured breakdown for a tier: prefer operator-entered fields, fall back
// to parsing the free-text pack_size (what the price-pull agents write).
export function tierBreakdown(t: PriceTier): {
  case_size: number | null;
  unit_of_measurement: string | null;
  case_type: string | null;
} {
  const parsed = parsePackSize(t.pack_size);
  return {
    case_size: t.case_size ?? parsed.case_size,
    unit_of_measurement: t.unit_of_measurement ?? parsed.unit_of_measurement,
    case_type: t.case_type ?? parsed.case_type,
  };
}

// A single representative pack-size breakdown for a whole lead (one row per lead
// exports), preferring operator-curated tiers, then the auto-pulled headline,
// then the raw scout listing text. Any field that can't be derived stays null.
export function leadPackBreakdown(payload: any): {
  case_size: number | null;
  unit_of_measurement: string | null;
  case_type: string | null;
} {
  const p = payload ?? {};
  const tier0 = Array.isArray(p.price_tiers) && p.price_tiers.length > 0 ? p.price_tiers[0] : null;
  if (tier0) return tierBreakdown(tier0);
  const pulled = p.marketplace_pull?.pack_size;
  if (typeof pulled === "string" && pulled.trim()) return parsePackSize(pulled);
  if (typeof p.pack_sizes_pricing === "string" && p.pack_sizes_pricing.trim()) {
    return parsePackSize(p.pack_sizes_pricing);
  }
  return { case_size: null, unit_of_measurement: null, case_type: null };
}

// Rebuild the free-text pack_size from the structured parts so downstream
// readers (display, $/unit math) stay populated after an operator edits the
// split cells. "25" + "kg" + "drum" -> "25 kg drum".
export function composePackSize(p: {
  case_size?: number | null;
  unit_of_measurement?: string | null;
  case_type?: string | null;
}): string | null {
  const sizeUnit = [p.case_size != null ? String(p.case_size) : "", p.unit_of_measurement ?? ""]
    .filter(Boolean)
    .join(" ");
  const out = [sizeUnit, p.case_type ?? ""].filter(Boolean).join(" ").trim();
  return out || null;
}

function numOrNull(v: unknown): number | null {
  return Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null;
}
function textOrNull(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.trim().slice(0, max) || null : null;
}

export function sanitizeTiers(input: unknown): PriceTier[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 30)
    .map((t: any) => ({
      pack_size: textOrNull(t?.pack_size, 120),
      price: numOrNull(t?.price),
      unit_price: numOrNull(t?.unit_price),
      case_size: numOrNull(t?.case_size),
      unit_of_measurement: textOrNull(t?.unit_of_measurement, 30),
      case_type: textOrNull(t?.case_type, 40),
      shipping_cost_estimate: numOrNull(t?.shipping_cost_estimate),
    }))
    .filter(
      (t) =>
        t.pack_size ||
        t.price != null ||
        t.unit_price != null ||
        t.case_size != null ||
        t.unit_of_measurement ||
        t.case_type ||
        t.shipping_cost_estimate != null,
    );
}
