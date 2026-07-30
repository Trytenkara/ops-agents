// The "onboarded bar" — the tighter quality bar applied once a client graduates
// from the early wide-net "motherlode" stage to "onboarded" (see migration 0058
// and setOrgOnboardingStage). A motherlode client wants everyone surfaced; an
// onboarded client wants only leads we have real confidence in.
//
// This is a PURE predicate over a stored lead row (same shape lead-match-tier and
// the Leads UI already read). It decides nothing on its own: the re-filter uses it
// to set a reversible advisory (payload.below_onboarded_bar) that shows as a badge
// in the Leads UI. Leads are NEVER dropped or filtered out — an operator still sees
// and can act on every one, consistent with the repo's "advisory flags, never
// filter" convention (see lib/lead-flags.ts).

import { deriveMatchTier } from "@/lib/lead-match-tier";

// Profile-completeness floor for an onboarded client. confidence_score is a 0..1
// completeness signal (share of outreach fields captured), NOT material fit — so a
// lead only fails on this when it has actually been scored (non-null) AND lands
// below the floor. Named + documented so the bar is easy to retune. 0.40 keeps
// half-built profiles visible-but-flagged rather than treating a blank profile
// (null score, e.g. not yet enriched) as a failure.
export const ONBOARDED_MIN_CONFIDENCE = 0.4;

export interface OnboardedBarResult {
  below: boolean;
  reason: string | null;
}

// A lead falls BELOW the onboarded bar when either:
//   1. its material-match tier is "potential" — we have no direct evidence this
//      supplier actually makes THIS material (the strongest signal), or
//   2. it has a scored confidence_score below ONBOARDED_MIN_CONFIDENCE — a thin,
//      low-completeness profile.
// Both are existing signals already surfaced in the Leads UI, so the demotion is
// explainable from what an operator can already see.
export function evaluateOnboardedBar(r: any): OnboardedBarResult {
  const reasons: string[] = [];

  const { tier } = deriveMatchTier(r);
  if (tier === "potential") {
    reasons.push("unconfirmed material match");
  }

  const score = r?.confidence_score;
  if (score != null && Number.isFinite(Number(score)) && Number(score) < ONBOARDED_MIN_CONFIDENCE) {
    reasons.push(`low confidence (${Math.round(Number(score) * 100)}% < ${Math.round(ONBOARDED_MIN_CONFIDENCE * 100)}%)`);
  }

  return reasons.length > 0
    ? { below: true, reason: reasons.join("; ") }
    : { below: false, reason: null };
}
