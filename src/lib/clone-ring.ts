// A cloned-listing ring: one actor posts the same listing over and over under a
// fleet of invented company names (an EC21 page under McGinley's LLDPE gave us
// "Ivory Cost Recycling", "Ivory Elsa Recycling", "Ivory Blic Recycling"... six
// sellers, one listing). Both signals are required together, because each one
// alone drops real suppliers:
//   - Shared listing slug alone: on ExportersIndia/IndiaMART/go4world the slug
//     is just the product name, so four genuine glycerin suppliers all sit at
//     /refined-glycerine.
//   - Similar names alone: half of China's exporters share a province and an
//     industry word ("Shandong Kejian Chemical" / "Shandong Near Chemical").
// One listing published under three or more names that are themselves
// near-duplicates of each other is the combination no honest page produces.
//
// Kept dependency-free so the backfill script can import it directly with
// `node --experimental-strip-types` and screen historical rows by the exact
// same rule the live split applies.

const LEGAL_FORM_TOKENS = new Set([
  "co", "ltd", "limited", "inc", "llc", "lc", "corp", "corporation", "company",
  "pvt", "private", "plc", "gmbh", "srl", "bv", "sa", "sdn", "bhd",
]);

export interface ClonedListingCandidate {
  supplier_name: string;
  product_url: string;
}

function nameTokens(name: string): Set<string> {
  return new Set(
    name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !LEGAL_FORM_TOKENS.has(t)),
  );
}

function nearDuplicateNames(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  // Two shared tokens is the floor: one shared word is a province or an
  // industry ("Chemical"), which proves nothing about common ownership.
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.6;
}

function slugOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\d+/g, "").replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  } catch {
    return "";
  }
}

export function screenClonedListings<T extends ClonedListingCandidate>(sellers: T[]): { kept: T[]; screened: T[] } {
  const groups = new Map<string, T[]>();
  for (const s of sellers) {
    const slug = slugOf(s.product_url);
    if (!slug) continue;
    const g = groups.get(slug);
    if (g) g.push(s);
    else groups.set(slug, [s]);
  }
  const cloned = new Set<string>();
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const tokens = g.map((s) => nameTokens(s.supplier_name));
    for (let i = 0; i < g.length; i++) {
      const ring = g.filter((_, j) => j === i || nearDuplicateNames(tokens[i], tokens[j]));
      if (new Set(ring.map((s) => s.supplier_name.trim().toLowerCase())).size < 3) continue;
      for (const s of ring) cloned.add(s.product_url);
    }
  }
  return {
    kept: sellers.filter((s) => !cloned.has(s.product_url)),
    screened: sellers.filter((s) => cloned.has(s.product_url)),
  };
}
