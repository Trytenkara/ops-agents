// Case dimensions for marketplace pricing, keyed by a normalized pack_size and
// cached in marketplace_case_dims (migration 0054). Populated by the
// case-dimensions skill (--marketplace-cache). Pages read this map and resolve a
// row's pack_size to an outer-case estimate for the freight calc.

export interface CaseDims {
  case_type: string | null;
  width: number | null;
  height: number | null;
  length: number | null;
  weight_kg: number | null;
}

// Mirror of normalize_pack() in the case-dimensions skill: drop qualifier
// parentheticals, lowercase, collapse whitespace, so noisy variants
// ("1 kg (min 100 kg)") collapse to the same cache key ("1 kg").
export function normalizePack(ps: string | null | undefined): string {
  if (!ps) return "";
  return ps
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function loadMarketplaceCaseDims(
  admin: { from: (t: string) => any }
): Promise<Record<string, CaseDims>> {
  const { data } = await admin
    .from("marketplace_case_dims")
    .select("pack_size_norm, case_type, case_dimensions");
  const out: Record<string, CaseDims> = {};
  for (const r of (data ?? []) as any[]) {
    const d = r.case_dimensions ?? {};
    out[r.pack_size_norm] = {
      case_type: r.case_type ?? null,
      width: d.width ?? null,
      height: d.height ?? null,
      length: d.length ?? null,
      weight_kg: d.packaging_case_weight ?? null,
    };
  }
  return out;
}

export function resolveCaseDims(
  map: Record<string, CaseDims>,
  packSize: string | null | undefined
): CaseDims | null {
  const k = normalizePack(packSize);
  return k ? map[k] ?? null : null;
}

// "Box/Bag 18 x 4 x 24 in" (case_type prefix optional). Null when no usable dims.
export function fmtCaseDims(d: CaseDims | null): string | null {
  if (!d || d.width == null || d.height == null || d.length == null) return null;
  const dims = `${d.width} x ${d.height} x ${d.length} in`;
  return d.case_type ? `${d.case_type} ${dims}` : dims;
}

// Rough magnitude of a pack_size string for picking the largest/bulk tier on the
// Leads view. Converts the leading quantity+unit to kg-ish; unknown → -1.
export function packMagnitudeKg(ps: string | null | undefined): number {
  if (!ps) return -1;
  const m = ps.toLowerCase().match(/([\d.]+)\s*(kg|g|lb|lbs|oz|ton|tonne|mt|gal|gallon|ml|l)\b/);
  if (!m) return /drum|tote|sack|super\s*sack|ibc|pallet/.test(ps.toLowerCase()) ? 1e6 : -1;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return -1;
  switch (m[2]) {
    case "g": return n / 1000;
    case "kg": return n;
    case "oz": return n * 0.0283495;
    case "lb":
    case "lbs": return n * 0.453592;
    case "ton":
    case "tonne":
    case "mt": return n * 1000;
    case "l":
    case "gal":
    case "gallon": return n; // treat volume ~ kg for ordering only
    case "ml": return n / 1000;
    default: return n;
  }
}
