// Shared price QA: one read-time verdict over a priced row, whoever wrote it.
//
// Agent 05 already guards its own write path (currency sniff, FX, non-positive,
// catastrophic move, not_marketplace). Those gates decide whether to PUBLISH a
// number. This is the second, independent question: given a published number,
// is it comparable and trustworthy enough for an operator to act on?
//
// It runs at READ time on purpose. Two writers land in marketplace_pull (the
// Vercel agent and the browserbase-price-pull skill) and a third path fills
// quote_profiles; a verdict computed on read covers all of them with no
// migration, no backfill, and no chance of the writers drifting apart the way
// the USD invariant did before migration 0068 forced it into the DB.
//
// Never edits data. It flags, it does not fix.

import { parsePackSize } from "@/lib/price-tiers";
import { DENSITY_RANK_LABEL, rankDensitySource, resolveDensity, type DensityIndex, type DensityKind, type DensityRank } from "@/lib/material-density";

export type QaVerdict = "pass" | "warn" | "needs_review";
export type QaSeverity = "info" | "warn" | "error";
export type PackClass = "retail" | "mid" | "bulk" | "unknown";

export interface QaFlag {
  code: string;
  message: string;
  severity: QaSeverity;
}

export interface QaResult {
  verdict: QaVerdict;
  flags: QaFlag[];
  /** USD per kilogram, the only basis on which two differently-packed quotes compare. */
  price_per_kg_usd: number | null;
  pack_class: PackClass;
  pack_kg: number | null;
}

export interface QaInput {
  material_name?: string | null;
  /** Total USD price for one pack. Callers must pass USD; conversion happens upstream. */
  price?: number | null;
  unit_price?: number | null;
  pack_size?: string | null;
  case_size?: number | null;
  unit_of_measurement?: string | null;
  density?: number | null;
  density_unit?: string | null;
  /** Where the density came from, so a $/kg that depends on one can be judged. */
  density_rank?: DensityRank | null;
  /** Bulk (a powder's fill density) or liquid, since only one of them fills a pack. */
  density_kind?: DensityKind | null;
  source_url?: string | null;
  /** "low" for aggregator listings (Agent 05 sets price_trust on the pull). */
  price_trust?: string | null;
  market_kind?: string | null;
  /**
   * True when the price was read off a web listing, so a source URL is mandatory.
   * A quote that arrived by supplier email legitimately has no URL (its citation
   * is the thread), so that case must not be flagged as a defect.
   */
  citation_required?: boolean;
}

const MASS_TO_KG: Record<string, number> = {
  kg: 1, g: 0.001, mg: 0.000001, lb: 0.453592, oz: 0.0283495, ton: 1000,
};
const VOLUME_TO_L: Record<string, number> = { L: 1, ml: 0.001, gal: 3.78541 };

// Approximate g/mL per material, wide bounds. Used ONLY to flag an outlier for a
// human, never to correct a value or to synthesize a missing one.
const DENSITY_GML: Array<[string, [number, number]]> = [
  ["refined glycerin", [1.23, 1.27]],
  ["glycerin", [1.23, 1.27]],
  ["glycerine", [1.23, 1.27]],
  ["propylene glycol", [1.02, 1.05]],
  ["monoethanolamine", [0.99, 1.03]],
  ["medium chain triglycerides", [0.92, 0.97]],
  ["caprylic", [0.92, 0.97]],
  ["cocamidopropyl betaine", [1.0, 1.07]],
  ["sodium hydroxide solution", [1.4, 1.55]],
  ["sulfuric acid", [1.78, 1.86]],
  ["hydrochloric acid", [1.14, 1.2]],
  ["isopropyl alcohol", [0.78, 0.80]],
  ["ethanol", [0.78, 0.80]],
  ["water", [0.99, 1.01]],
];

function num(x: unknown): number | null {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

// The pull agents write 0 for "not derived" as often as null, so a zero must not
// shadow the value we can parse out of the pack-size text.
function positive(x: unknown): number | null {
  const n = num(x);
  return n != null && n > 0 ? n : null;
}

/** Density in g/mL. Accepts g/mL-family units and lb/gal; unknown units yield null. */
export function densityGml(density: unknown, unit: unknown): number | null {
  const d = num(density);
  if (d == null || d <= 0) return null;
  const u = String(unit ?? "").toLowerCase().replace(/\s/g, "");
  if (u.includes("lb") && u.includes("gal")) return d * 0.119826;
  if (u === "" || u === "sg" || u === "g/ml" || u === "g/cm3" || u === "g/cc" || u === "kg/l") return d;
  return null;
}

function expectedDensity(material: string | null | undefined): [number, number] | null {
  const m = (material ?? "").toLowerCase();
  if (!m) return null;
  for (const [key, range] of DENSITY_GML) if (m.includes(key)) return range;
  return null;
}

/**
 * Mass of one pack in kg. Mass units convert directly; volume units need a real
 * density. We deliberately do NOT assume 1.0 g/mL for an unknown liquid. That is
 * a 26% error on glycerin, and a guessed comparison basis is a fabricated number.
 * Returns null instead, and the caller flags why.
 */
export function packKg(input: QaInput): { kg: number | null; reason: string | null; basis: "mass" | "density" | null } {
  const parsed = parsePackSize(input.pack_size);
  const size = positive(input.case_size) ?? parsed.case_size;
  const unit = input.unit_of_measurement || parsed.unit_of_measurement;
  if (size == null || size <= 0 || !unit) return { kg: null, reason: "no_pack_size", basis: null };

  if (MASS_TO_KG[unit] != null) return { kg: size * MASS_TO_KG[unit], reason: null, basis: "mass" };

  if (VOLUME_TO_L[unit] != null) {
    const g = densityGml(input.density, input.density_unit);
    if (g == null) return { kg: null, reason: "density_missing_for_volume_pack", basis: null };
    return { kg: size * VOLUME_TO_L[unit] * g, reason: null, basis: "density" };
  }

  // ea / unit / ct / pc is a count, not a mass. Nothing to compare on.
  return { kg: null, reason: "countable_pack", basis: null };
}

function packClass(kg: number | null): PackClass {
  if (kg == null) return "unknown";
  if (kg < 5) return "retail";
  if (kg < 50) return "mid";
  return "bulk";
}

const RANK: Record<QaVerdict, number> = { pass: 0, warn: 1, needs_review: 2 };

export function qaPrice(input: QaInput): QaResult {
  const flags: QaFlag[] = [];
  let verdict: QaVerdict = "pass";
  const add = (code: string, message: string, severity: QaSeverity) => {
    flags.push({ code, message, severity });
    const to: QaVerdict = severity === "error" ? "needs_review" : severity === "warn" ? "warn" : "pass";
    if (RANK[to] > RANK[verdict]) verdict = to;
  };

  const price = num(input.price);
  const parsed = parsePackSize(input.pack_size);
  const caseSize = positive(input.case_size) ?? parsed.case_size;

  if (price != null && !input.source_url) {
    add(
      "priced_without_citation",
      input.citation_required
        ? "Listing price with no source URL to verify it against."
        : "No source URL on file. Expected for a quote that arrived by email; a defect if it came from a listing.",
      input.citation_required ? "error" : "warn",
    );
  }

  // Below a dollar the missing pack size stops being an inconvenience and becomes
  // decisive: $0.52 is a plausible per-kg rate whose basis was lost, and an
  // implausible price for a pack. Either way it cannot be published or compared.
  // Both live in our data: a Shopify feed returning $0.01 for starch, and supplier
  // quotes stored as a bare per-kg number.
  if (price != null && price > 0 && price < 1 && !caseSize) {
    add("sub_dollar_no_basis", `$${price} with no pack size. At this price it is a per-unit rate with a lost basis or a placeholder SKU, not a usable pack price.`, "error");
  }

  if (price != null && caseSize == null) {
    add("no_pack_size", "Priced, but the pack size is unknown, so this cannot be compared to another quote.", "warn");
  }

  // A stored unit_price of 0 means "not derived", not "costs nothing". The pull
  // agents write 0 far more often than a real per-unit figure.
  const unitPrice = num(input.unit_price);
  if (price != null && unitPrice != null && unitPrice > 0 && caseSize != null && caseSize > 0) {
    const expect = price / caseSize;
    if (expect > 0 && Math.abs(unitPrice - expect) / expect > 0.03) {
      add("unit_price_math_off", `Per-unit ${unitPrice} disagrees with price/size ${expect.toFixed(4)}.`, "warn");
    }
  }

  if (input.price_trust === "low" || input.market_kind === "aggregator") {
    add("aggregator_low_trust", "Aggregator listing. The seller and the price are both unverified.", "warn");
  }

  const g = densityGml(input.density, input.density_unit);
  if (input.density != null && g == null) {
    add("density_unit_unrecognized", `Density ${input.density} has an unusable unit (${input.density_unit ?? "none"}).`, "warn");
  }
  const range = expectedDensity(input.material_name);
  if (g != null && range && !(g >= range[0] * 0.9 && g <= range[1] * 1.1)) {
    add("density_implausible", `Density ~${g.toFixed(3)} g/mL is outside the expected ${range[0]}-${range[1]} for this material.`, "warn");
  }

  const { kg, reason, basis } = packKg(input);
  if (price != null && reason === "density_missing_for_volume_pack") {
    add("density_missing_for_volume_pack", "Liquid pack with no density on file, so $/kg cannot be computed honestly.", "info");
  }
  // A $/kg that rests on a density is only as good as where the density came from.
  // A pack already quoted in mass units rests on nothing, so it is not flagged.
  if (price != null && kg != null && basis === "density" && g != null) {
    const rank: DensityRank = input.density_rank ?? "unattributed";
    const what = input.density_kind === "bulk" ? "bulk density" : "density";
    add(
      "converted_via_density",
      `$/kg uses ${what} ${g.toFixed(3)} g/ml (${DENSITY_RANK_LABEL[rank]}), not a weight printed on the listing.`,
      rank === "unattributed" ? "warn" : "info",
    );
  }

  const cls = packClass(kg);
  if (price != null && cls === "retail") {
    add("retail_pack", `${kg?.toFixed(2)} kg pack, a retail size rather than a wholesale comparable.`, "info");
  }

  return {
    verdict,
    flags,
    price_per_kg_usd: price != null && kg != null && kg > 0 ? Number((price / kg).toFixed(4)) : null,
    pack_class: cls,
    pack_kg: kg != null ? Number(kg.toFixed(4)) : null,
  };
}

/**
 * QA one price tier of a marketplace lead. Tier prices are USD by DB invariant (0068).
 * Pass the org's density index to give volumetric packs an honest $/kg; without it
 * they stay uncomparable rather than being converted on a guess.
 */
export function qaLeadTier(payload: any, tier: any, densities?: DensityIndex): QaResult {
  const pull = payload?.marketplace_pull ?? {};
  const d = densities ? resolveDensity(densities, payload?.material_name) : null;
  return qaPrice({
    material_name: payload?.material_name ?? null,
    density: d?.density ?? null,
    density_unit: d?.unit ?? null,
    density_rank: d?.rank ?? null,
    density_kind: d?.kind ?? null,
    price: tier?.price ?? null,
    unit_price: tier?.unit_price ?? null,
    pack_size: tier?.pack_size ?? null,
    case_size: tier?.case_size ?? null,
    unit_of_measurement: tier?.unit_of_measurement ?? null,
    source_url: pull.source_url ?? payload?.source_url ?? payload?.supplier_website ?? null,
    price_trust: pull.price_trust ?? null,
    market_kind: pull.market_kind ?? null,
    citation_required: true,
  });
}

/** QA a quote_profiles row, the enrichment side of the same question. */
export function qaQuoteProfile(p: any): QaResult {
  return qaPrice({
    material_name: p?.material_name ?? null,
    price: p?.price ?? null,
    unit_price: p?.unit_price ?? null,
    case_size: p?.case_size ?? null,
    unit_of_measurement: p?.unit_of_measurement ?? null,
    density: p?.density ?? null,
    density_unit: p?.density_unit ?? null,
    density_rank: rankDensitySource(p?.density_source),
    source_url: p?.source_url ?? null,
  });
}
