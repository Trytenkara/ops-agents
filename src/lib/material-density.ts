// Density index: the per-material densities we already know, resolved at read time.
//
// Density is a property of the MATERIAL, not of a quote, but we only ever stored
// it on quote_profiles. So a lead price tier priced in litres had no density to
// convert with and reported "no honest $/kg", even when another row in the same
// org already carried a sourced value for that exact material. This joins the two.
//
// Sources are ranked, because they are not equally good: a BASF SDS and a
// Wikipedia infobox both sit in density_source today. A lower-ranked source never
// displaces a higher-ranked one, and the rank travels with the value so an
// operator can see what a $/kg figure rests on.

import { correctMaterialSpelling } from "@/lib/material-spelling";

/** Best to worst. The precedence rule: operator-set > this listing > its own SDS/TDS > general web. */
export type DensityRank = "operator" | "listing" | "document" | "web" | "unattributed";

export const DENSITY_RANK_ORDER: DensityRank[] = ["operator", "listing", "document", "web", "unattributed"];

export const DENSITY_RANK_LABEL: Record<DensityRank, string> = {
  operator: "set by an operator",
  listing: "printed on the supplier's listing",
  document: "the supplier's SDS / spec sheet",
  web: "general web source",
  unattributed: "no source recorded",
};

/**
 * Which density this is. Converting a pack means asking how much product fits in
 * the container: specific gravity for a liquid, BULK density for a powder. A
 * crystal ("true") density is a different number, up to 4x higher, and is never
 * stored for this purpose.
 */
export type DensityKind = "liquid" | "bulk";

export interface MaterialDensity {
  /** g/ml, numerically equal to g/cm3 and kg/L. */
  density: number;
  unit: string;
  kind: DensityKind | null;
  source: string | null;
  rank: DensityRank;
}

export type DensityIndex = Record<string, MaterialDensity>;

export function densityRankBetter(a: DensityRank, b: DensityRank): boolean {
  return DENSITY_RANK_ORDER.indexOf(a) < DENSITY_RANK_ORDER.indexOf(b);
}

// Values we write from here on carry an explicit tag. Everything already in the
// table is a bare URL, so infer: a document URL is an SDS/TDS, anything else is
// general web, and a value with no source at all claims nothing.
const TAG = /^\s*\[(operator|listing|document|sds|web)\]/i;
const DOCUMENT_URL = /(sds|msds|tds|data[-_]?sheet|spec[-_]?sheet|specification)/i;

export function rankDensitySource(source: string | null | undefined): DensityRank {
  const s = (source ?? "").trim();
  if (!s) return "unattributed";
  const tagged = s.match(TAG);
  if (tagged) {
    const t = tagged[1].toLowerCase();
    return t === "sds" ? "document" : (t as DensityRank);
  }
  if (!/^https?:\/\//i.test(s)) return "unattributed";
  if (DOCUMENT_URL.test(s) || /\.pdf(\?|$)/i.test(s)) return "document";
  return "web";
}

/**
 * Exact-match key only. "Sodium Hydroxide" and "Sodium Hydroxide Solution" differ
 * by 50% in density, so fuzzy matching here would quietly fabricate a $/kg. We
 * correct known typos and drop a trailing acronym, and otherwise require the names
 * to agree.
 */
export function materialKey(name: string | null | undefined): string {
  if (!name) return "";
  return correctMaterialSpelling(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function resolveDensity(index: DensityIndex, materialName: string | null | undefined): MaterialDensity | null {
  const k = materialKey(materialName);
  return k ? index[k] ?? null : null;
}

/**
 * Every density we know, best source per material.
 *
 * Two stores, merged: material_densities (the material-level table, where a
 * looked-up value lands) and quote_profiles (where densities were recorded
 * before that table existed). Neither is authoritative by position; the better
 * ranked source wins, so an operator-set value is never overwritten in the
 * index by a web one that happens to live in the other table.
 */
export async function loadMaterialDensities(
  admin: { from: (t: string) => any },
  orgId?: string,
): Promise<DensityIndex> {
  const out: DensityIndex = {};
  const put = (name: string, density: unknown, unit: unknown, source: string | null, rank: DensityRank, kind: DensityKind | null) => {
    const key = materialKey(name);
    const d = Number(density);
    if (!key || !Number.isFinite(d) || d <= 0) return;
    const prev = out[key];
    if (prev && !densityRankBetter(rank, prev.rank)) return;
    out[key] = { density: d, unit: (unit as string) || "g/ml", kind, source, rank };
  };

  let q = admin
    .from("quote_profiles")
    .select("material_name, density, density_unit, density_source")
    .not("density", "is", null);
  if (orgId) q = q.eq("org_id", orgId);
  const [profiles, table] = await Promise.all([
    q,
    admin.from("material_densities").select("material_name, density, unit, kind, source, source_rank"),
  ]);

  for (const r of (profiles?.data ?? []) as any[]) {
    put(r.material_name, r.density, r.density_unit, r.density_source ?? null, rankDensitySource(r.density_source), null);
  }
  for (const r of (table?.data ?? []) as any[]) {
    put(r.material_name, r.density, r.unit, r.source ?? null, (r.source_rank as DensityRank) ?? "unattributed", (r.kind as DensityKind) ?? null);
  }
  return out;
}
