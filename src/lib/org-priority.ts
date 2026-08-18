// Who drains a shared, capped queue first.
//
// Standing rule: real (paying) clients always get scarce agent throughput
// before internal test orgs. Internal orgs still get served, but only with the
// capacity left over. Without it, one large internal test discovery flood sits
// ahead of a live client in a FIFO and starves it for a whole run.
//
// This lived as five separate hand-rolled comparators across the fleet, which
// is how a new capped queue ends up quietly serving them first-come. Import
// from here instead of writing a sixth.

const PAUSED = "off";

export interface PriorityOrg {
  is_internal?: boolean | null;
  sourcing_status?: string | null;
  slug?: string | null;
}

/**
 * Lower runs first. Real clients (is_internal === false) beat everything; an
 * unknown is_internal is treated as internal, because guessing the other way
 * would let an unlabelled org jump a paying one. An org the fleet is not
 * actively sourcing for goes behind its own tier: its work is not urgent, but
 * it is not skipped either.
 */
export function orgPriorityRank(org: PriorityOrg | null | undefined): number {
  const real = org?.is_internal === false;
  const paused = (org?.sourcing_status ?? PAUSED) === PAUSED;
  return (real ? 0 : 2) + (paused ? 1 : 0);
}

/**
 * Comparator for use as the FIRST key of a composite sort, where the caller has
 * its own tiebreakers (most-visited, display name). Returns 0 for same tier so
 * the caller's next key decides.
 */
export function compareOrgPriority(a: PriorityOrg | null | undefined, b: PriorityOrg | null | undefined): number {
  return orgPriorityRank(a) - orgPriorityRank(b);
}

/** Sort in place-safe order: real clients first, then by slug for stability. */
export function sortOrgsByPriority<T extends PriorityOrg>(orgs: T[]): T[] {
  return [...orgs].sort(
    (a, b) => orgPriorityRank(a) - orgPriorityRank(b) || (a.slug ?? "").localeCompare(b.slug ?? "")
  );
}

/** Sort arbitrary items whose org is looked up by id. Lower rank first. */
export function sortByOrgPriority<T>(
  items: T[],
  orgOf: (item: T) => PriorityOrg | null | undefined
): T[] {
  return [...items].sort((a, b) => orgPriorityRank(orgOf(a)) - orgPriorityRank(orgOf(b)));
}

/**
 * Split a set of orgs into the two drain phases. Callers that fill a cap in
 * passes (real clients first, internal only with what is left) want this rather
 * than a sort.
 */
export function partitionRealVsInternal<T extends PriorityOrg>(orgs: T[]): { real: T[]; internal: T[] } {
  return {
    real: orgs.filter((o) => o.is_internal === false),
    internal: orgs.filter((o) => o.is_internal !== false),
  };
}
