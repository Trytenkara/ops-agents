// What a marketplace pull is telling an operator, in one place.
//
// Three surfaces each decided this for themselves, and all three decided it on
// `status === "needs_manual_pull"` — a status migration 0089 retired and no
// writer has emitted since. So every one of them rendered nothing, forever,
// while the live signals sat unread beside them: `flagged` on a pending pull,
// and a price the publish gate took away (PERS-07, UI-06).
//
// A surface that gates on a status nobody writes is indistinguishable from a
// surface that works, which is why this is shared rather than repeated.

export interface MarketplacePullShape {
  status?: string | null;
  reason?: string | null;
  flagged?: boolean | null;
  withheld?: boolean | null;
  withheld_reason?: string | null;
  price?: number | null;
}

const SCRAPE_REASON_LABEL: Record<string, string> = {
  link_broken: "link broken",
  login_required: "price behind login",
  needs_review: "no price found on page",
};

/**
 * Does this pull need a person, and what should the flag say?
 *
 * Null when the pull is fine or still in the ordinary retry rotation — a
 * pending pull nobody has flagged is the fleet working, not work owed.
 */
export function pullNeedsOperator(
  mp: MarketplacePullShape | null | undefined
): { label: string; detail: string } | null {
  if (!mp) return null;
  // A page we read and could not publish from. Distinct from every other case
  // here: the number exists and is one operator glance away.
  if (mp.withheld) {
    return {
      label: "price withheld",
      detail: mp.withheld_reason ?? "The price read off this listing could not be published, with no reason recorded.",
    };
  }
  const label = (r: string | null | undefined) => SCRAPE_REASON_LABEL[r ?? ""] ?? "needs a manual price";
  if (mp.status === "pending" && mp.flagged) {
    return { label: label(mp.reason), detail: "The scrape has given up on this listing for now — enter the price by hand." };
  }
  // Rows written before migration 0089 retired the status. Kept so those leads
  // stay visible; nothing writes it any more.
  if (mp.status === "needs_manual_pull") {
    return { label: label(mp.reason), detail: "Auto-scrape could not get a price — an operator must enter it manually." };
  }
  return null;
}
