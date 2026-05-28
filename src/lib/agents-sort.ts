// Extract the leading 2-digit agent number from a slug like
// "agent-08-email-scanner" → 8. Returns 999 for slugs that don't match,
// so they sort to the end without crashing.
export function agentNumberFromSlug(slug: string | null | undefined): number {
  if (!slug) return 999;
  const m = /^agent-(\d+)/.exec(slug);
  return m ? parseInt(m[1], 10) : 999;
}

export function compareAgentsBySlug<T extends { slug?: string | null }>(a: T, b: T): number {
  const na = agentNumberFromSlug(a.slug);
  const nb = agentNumberFromSlug(b.slug);
  if (na !== nb) return na - nb;
  return (a.slug ?? "").localeCompare(b.slug ?? "");
}
