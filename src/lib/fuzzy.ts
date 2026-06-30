import { normalizeCompanyName } from "@/lib/tenkara-sourcing-exclusions";

// Lightweight fuzzy string matching for supplier dedup — no dependency. Uses the
// Sørensen–Dice coefficient over character bigrams, which is fast and forgiving
// of typos, word order, and spacing. We compare *normalized* company names
// (suffixes/punctuation stripped) so "Acme Inc." and "ACME, Incorporated" are
// already identical before fuzz even runs.

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

// 0 (nothing in common) … 1 (identical), on the raw strings passed in.
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const ma = bigrams(a);
  const mb = bigrams(b);
  let intersection = 0;
  for (const [g, ca] of ma) {
    const cb = mb.get(g);
    if (cb) intersection += Math.min(ca, cb);
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

// True if two company names are the same company allowing for typos/variants.
// Exact after normalization → match; otherwise Dice similarity ≥ threshold.
export function isSameCompanyName(a: string | null | undefined, b: string | null | undefined, threshold = 0.9): boolean {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Guard tiny strings where bigram similarity is noisy (e.g. "abc" vs "abd").
  if (na.length < 5 || nb.length < 5) return false;
  return diceCoefficient(na, nb) >= threshold;
}
