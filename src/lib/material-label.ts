// A material's canonical label is its NAME (the specific, sourceable identity),
// falling back to the trade/brand name only when the name is absent. Empty
// strings are treated as absent — the Tenkara bulk importer writes trade_name=''
// (not NULL) on unbranded materials, and a plain `?? ` / SQL `coalesce` treats
// that empty string as a real value, which surfaced blank material names and let
// brand names ("Morton") stand in for the material ("Salt").
//
// Keep this in lockstep with MATERIAL_LABEL_SQL below.
export function materialLabel(
  m: { name?: string | null; trade_name?: string | null },
  fallback: string | null = null
): string | null {
  const name = m.name?.trim();
  if (name) return name;
  const trade = m.trade_name?.trim();
  if (trade) return trade;
  return fallback;
}

// SQL equivalent of materialLabel (name-first, empty-string-safe). Assumes the
// materials table is aliased as `m`.
export const MATERIAL_LABEL_SQL =
  "coalesce(nullif(btrim(m.name), ''), nullif(btrim(m.trade_name), ''))";
