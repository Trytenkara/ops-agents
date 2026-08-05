// Whether a supplier can ship to the United States, and what we do about it.
//
// A supplier that cannot ship to the US is NOT a dead lead: California Chemicals
// and the other distributor clients buy at origin and move the freight
// themselves, and a drop-ship arrangement never needs the supplier to touch the
// US at all. So this is recorded as an annotation and surfaced as a badge, and
// nothing here ever filters, stages down, or terminates a lead.

export type ShipsToUsVerdict = "yes" | "no";

export interface ShipsToUsAnnotation {
  verdict: ShipsToUsVerdict;
  said_at: string;
  source: "supplier_reply";
  // The supplier's own words, so an operator can judge the verdict rather than
  // trust it. Null when the extractor gave a verdict but quoted nothing.
  evidence: string | null;
}

// Country strings on a lead payload come from four different discovery sources,
// so they are a mix of ISO codes and full names ("CN", "China", "USA", "US").
const US_ALIASES = new Set([
  "us",
  "usa",
  "unitedstates",
  "unitedstatesofamerica",
  "unitedstatesamerica",
  "america",
]);

// True only when we positively know the supplier sits outside the US. An unknown
// or unparseable country returns false: we ask about collection at origin because
// we know they are abroad, never on a guess.
export function isNonUsSupplier(country: string | null | undefined): boolean {
  const raw = (country ?? "").trim();
  if (!raw) return false;
  const norm = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!norm) return false;
  return !US_ALIASES.has(norm);
}

export function shipsToUsVerdict(payload: Record<string, any> | null | undefined): ShipsToUsVerdict | null {
  const v = (payload ?? {})?.ships_to_us?.verdict;
  return v === "yes" || v === "no" ? v : null;
}
