// Material-match tiering for staged leads. Distinct from `confidence_score`
// (which reflects profile completeness, not whether the supplier actually makes
// the material): this splits leads into "Confirmed" — we have direct evidence
// they make THIS material — vs "Potential" — surfaced by a looser tag/keyword
// match that still needs an operator to verify. Scout leads confirm via a cited
// product page; ImportYeti via US-customs shipments; SourceReady only if the
// material name actually appears in the supplier's listed products/tags.

export type MatchTier = "confirmed" | "potential";

// Generic words that appear across unrelated material names — matching on these
// would falsely "confirm" a supplier (e.g. any "…fruit…" tag). Require a match
// on a distinctive token instead.
const GENERIC_TOKENS = new Set([
  "extract", "powder", "fruit", "seed", "oil", "acid", "natural", "organic",
  "refined", "grade", "annuum", "fluid", "liquid", "water", "root", "leaf",
  "flower", "fragrance", "blend", "juice", "dried", "pure", "food", "cosmetic",
]);

// ImportYeti confirmation thresholds — a specialised exporter with a real
// customs footprint, not a one-off shipment.
const IY_MIN_SHIPMENTS = 5;
const IY_MIN_SPECIALIZATION = 15; // percent

// Distinctive tokens of a string: drop parenthetical abbreviations (e.g.
// "(CAPB)"), split, then keep only the material-identifying words (>=4 chars,
// not a generic filler like "extract"/"powder").
function distinctiveTokens(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .replace(/\(.*?\)/g, " ")
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t))
  );
}

function setEq(a: Set<string>, b: Set<string>): boolean {
  return a.size > 0 && a.size === b.size && [...a].every((x) => b.has(x));
}

// Strict SourceReady match: the material must appear as a STANDALONE tag in the
// supplier's own SourceReady categorisation — i.e. a tag whose distinctive
// tokens equal the material's (or its INCI's). A tag that merely contains the
// material as a qualifier ("glycerin soap base", "propylene glycol ethers")
// does NOT confirm — those are finished-goods makers that only use it.
function sourceReadyTagsNameMaterial(r: any): boolean {
  const tags = Array.isArray(r?.payload?.sourceready_tags) ? r.payload.sourceready_tags : [];
  if (tags.length === 0) return false;
  const mat = distinctiveTokens(r?.material_name);
  const inci = distinctiveTokens(r?.payload?.inci_name);
  return tags.some((tag: string) => {
    const t = distinctiveTokens(tag);
    return setEq(t, mat) || setEq(t, inci);
  });
}

export function deriveMatchTier(r: any): { tier: MatchTier; reason: string } {
  const source = (r?.source ?? "").toString();
  const p = r?.payload ?? {};
  switch (source) {
    case "existing_db":
      return { tier: "confirmed", reason: "From the platform database (known supplier history)." };
    case "human_bulk_upload":
      return { tier: "confirmed", reason: "Added by ops via CSV upload." };
    case "marketplace":
      return { tier: "confirmed", reason: "Matched from the Sourcing Index catalog for this material." };
    case "ai_discovery": {
      const hasLink =
        (typeof p.source_url === "string" && p.source_url) ||
        (Array.isArray(p.source_citations) && p.source_citations.length > 0) ||
        (typeof p.supplier_website === "string" && p.supplier_website);
      return hasLink
        ? { tier: "confirmed", reason: "Scout cited a supplier page for this material." }
        : { tier: "potential", reason: "Scout lead without a source citation — verify the material fit." };
    }
    case "importyeti": {
      const iy = p.importyeti ?? {};
      const shipments = Number(iy.matching_shipments ?? 0);
      const spec = Number(iy.specialization ?? 0);
      return shipments >= IY_MIN_SHIPMENTS && spec >= IY_MIN_SPECIALIZATION
        ? {
            tier: "confirmed",
            reason: `US-customs proof — ${shipments} matching shipments, ${Math.round(spec)}% specialised.`,
          }
        : {
            tier: "potential",
            reason: `Thin ImportYeti signal (${shipments} shipments, ${Math.round(spec)}% specialised) — verify the material fit.`,
          };
    }
    case "sourceready":
      return sourceReadyTagsNameMaterial(r)
        ? { tier: "confirmed", reason: "SourceReady tags name this material." }
        : {
            tier: "potential",
            reason:
              "SourceReady tag-match only — the raw material isn't in their listed products; verify they actually make it.",
          };
    default:
      return { tier: "potential", reason: "Unverified source — verify the material match." };
  }
}

// 0 = confirmed, 1 = potential. For sorting confirmed leads to the top.
export function matchTierRank(r: any): number {
  return deriveMatchTier(r).tier === "confirmed" ? 0 : 1;
}
