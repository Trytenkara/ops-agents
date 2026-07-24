// Per-org agent timing ("fast-track" / motherlode mode). The compressed cadence
// (fast no-reply nudges, calling escalation, and outreach compile-wait) applies
// only to orgs on the fast-track list; every other org uses the production
// defaults so real suppliers aren't hit with rapid-fire follow-ups. The
// compressed values come from FOLLOWUP_MINUTES / CALLING_ESCALATE_AFTER_MINUTES /
// OUTREACH_COMPILE_WAIT_MINUTES; the fast-track set is FAST_TRACK_ORG_IDS (csv of
// OA org ids), defaulting to the Sierra Materials test org.

const MINUTE = 60 * 1000;
const DAY = 24 * 3600 * 1000;

// Production defaults (used for every org not in the compressed set).
const PROD_FOLLOWUP_DELAYS_MS: number[] = [4 * DAY, 8 * DAY];
const PROD_CALLING_ESCALATE_AFTER_MS = 2 * DAY;
const PROD_COMPILE_WAIT_MS = 7 * DAY;

// OA org id of the Sierra Materials test org — the default fast-track target so
// its test cadence keeps working without extra config. Override the whole set
// with FAST_TRACK_ORG_IDS (csv of OA org ids), e.g. to fast-track a new client.
const SIERRA_ORG_ID = "ce863603-3667-42f7-819d-d4f8a0087a27";

export function fastTrackOrgIds(): Set<string> {
  const raw = (process.env.FAST_TRACK_ORG_IDS ?? "").trim();
  if (raw) return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return new Set([SIERRA_ORG_ID]);
}

function usesCompressed(orgId: string | null | undefined): boolean {
  return !!orgId && fastTrackOrgIds().has(orgId);
}

function envFollowupDelaysMs(): number[] | null {
  const raw = (process.env.FOLLOWUP_MINUTES ?? "").trim();
  if (!raw) return null;
  const mins = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return mins.length ? mins.map((m) => m * MINUTE) : null;
}

function envCallingEscalateAfterMs(): number | null {
  const raw = (process.env.CALLING_ESCALATE_AFTER_MINUTES ?? "").trim();
  const mins = Number(raw);
  return raw && Number.isFinite(mins) && mins >= 0 ? mins * MINUTE : null;
}

function envCompileWaitMs(): number | null {
  const raw = (process.env.OUTREACH_COMPILE_WAIT_MINUTES ?? "").trim();
  const mins = Number(raw);
  return raw && Number.isFinite(mins) && mins >= 0 ? mins * MINUTE : null;
}

// Delay before each no-reply nudge, as ms-after-sent. The list length also sets
// how many nudges are sent. Prod default 4d/8d; compressed orgs use FOLLOWUP_MINUTES.
export function followupDelaysMs(orgId: string | null | undefined): number[] {
  if (!usesCompressed(orgId)) return PROD_FOLLOWUP_DELAYS_MS;
  return envFollowupDelaysMs() ?? PROD_FOLLOWUP_DELAYS_MS;
}

// Grace after the last follow-up before escalating to a phone call. Prod default
// 2d; compressed orgs use CALLING_ESCALATE_AFTER_MINUTES.
export function callingEscalateAfterMs(orgId: string | null | undefined): number {
  if (!usesCompressed(orgId)) return PROD_CALLING_ESCALATE_AFTER_MS;
  return envCallingEscalateAfterMs() ?? PROD_CALLING_ESCALATE_AFTER_MS;
}

// How long outreach waits for a supplier's sibling materials to finish enriching
// before sending anyway. Prod default 7d; compressed orgs use OUTREACH_COMPILE_WAIT_MINUTES.
export function compileWaitMs(orgId: string | null | undefined): number {
  if (!usesCompressed(orgId)) return PROD_COMPILE_WAIT_MS;
  return envCompileWaitMs() ?? PROD_COMPILE_WAIT_MS;
}
