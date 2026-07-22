// Shared misspelling handling for raw-material / ingredient names. Used by:
//  - the outreach drafter, so a typo never reaches a sent email;
//  - the Control Room name resolvers + pages, so operators never see a typo;
//  - the draft QA lint (likely_misspelling), as a backstop for paths that don't
//    correct first (e.g. supplier-reply drafts, manual edits).
//
// Keys are the wrong spelling, values the correction. Only high-confidence
// pairs where the key is unambiguously a typo (NOT a valid British/variant
// spelling like "glycerine" or "camomile") — a false positive rewrites a
// correctly-spelled name, so we err toward under-covering. Extend as ops
// surfaces new ones. Matched whole-word, case-insensitive.
export const MATERIAL_MISSPELLINGS: Record<string, string> = {
  cayanne: "cayenne",
  cayene: "cayenne",
  tumeric: "turmeric",
  termeric: "turmeric",
  cinamon: "cinnamon",
  ashwaganda: "ashwagandha",
  ashwaghanda: "ashwagandha",
  collegen: "collagen",
  collagin: "collagen",
  magnisium: "magnesium",
  magnesuim: "magnesium",
  pottassium: "potassium",
  potasium: "potassium",
  calcuim: "calcium",
  hyaluranic: "hyaluronic",
  hyularonic: "hyaluronic",
  niacinomide: "niacinamide",
  caffiene: "caffeine",
  chamomille: "chamomile",
  lavendar: "lavender",
  eucalyptis: "eucalyptus",
  pepperment: "peppermint",
  asorbic: "ascorbic",
  xantham: "xanthan",
  lecitin: "lecithin",
  maltodextrine: "maltodextrin",
  spirulena: "spirulina",
  fenugreak: "fenugreek",
  tocopheral: "tocopherol",
  glyserin: "glycerin",
  probiotc: "probiotic",
};

const MISSPELLING_RE = new RegExp(`\\b(${Object.keys(MATERIAL_MISSPELLINGS).join("|")})\\b`, "gi");

// Match the correction's casing to the typo it replaces so "Cayanne" -> "Cayenne"
// and "CAYANNE" -> "CAYENNE", not a lowercase splice into a Title-Cased name.
function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// Replace any known misspelled material name with its correction, in place.
// Unknown words are left untouched. Null/empty passes through unchanged so
// callers can wrap nullable names.
export function correctMaterialSpelling(text: string): string;
export function correctMaterialSpelling(text: string | null): string | null;
export function correctMaterialSpelling(text: string | null | undefined): string | null | undefined;
export function correctMaterialSpelling(text: string | null | undefined): string | null | undefined {
  if (!text) return text;
  return text.replace(MISSPELLING_RE, (m) => {
    const fix = MATERIAL_MISSPELLINGS[m.toLowerCase()];
    return fix ? matchCase(m, fix) : m;
  });
}

// Return the distinct typos found in a piece of text as [wrong, corrected]
// pairs (empty if none). Used by the lint backstop to describe findings.
export function findMisspellings(text: string): Array<[string, string]> {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(MISSPELLING_RE)) {
    const hit = m[1].toLowerCase();
    const fix = MATERIAL_MISSPELLINGS[hit];
    if (fix && fix.toLowerCase() !== hit) seen.set(hit, fix);
  }
  return Array.from(seen.entries());
}
