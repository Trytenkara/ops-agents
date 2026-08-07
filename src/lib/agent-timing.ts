// Per-org agent timing ("fast-track" / motherlode mode). The compressed cadence
// (fast no-reply nudges, call tasks, and outreach compile-wait) applies only to
// orgs on the fast-track list; every other org uses the production defaults so
// real suppliers aren't hit with rapid-fire follow-ups. The compressed values
// come from FOLLOWUP_MINUTES / CALL_TASK_MINUTES / OUTREACH_COMPILE_WAIT_MINUTES;
// the fast-track set is FAST_TRACK_ORG_IDS (csv of OA org ids), defaulting to the
// Sierra Materials test org.
//
// The live cadence interleaves email and phone, all offsets measured from the
// day the RFQ went out:
//   day 0  RFQ (Agent 04)      day 1  call task #1
//   day 2  nudge #1            day 5  call task #2 (only if still no reply)
//   day 4  nudge #2

const MINUTE = 60 * 1000;
const DAY = 24 * 3600 * 1000;

// Production defaults (used for every org not in the compressed set).
const PROD_FOLLOWUP_DELAYS_MS: number[] = [2 * DAY, 4 * DAY];
const PROD_CALL_TASK_DELAYS_MS: number[] = [1 * DAY, 5 * DAY];
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

function envCallTaskDelaysMs(): number[] | null {
  const raw = (process.env.CALL_TASK_MINUTES ?? "").trim();
  if (!raw) return null;
  const mins = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
  return mins.length ? mins.map((m) => m * MINUTE) : null;
}

function envCompileWaitMs(): number | null {
  const raw = (process.env.OUTREACH_COMPILE_WAIT_MINUTES ?? "").trim();
  const mins = Number(raw);
  return raw && Number.isFinite(mins) && mins >= 0 ? mins * MINUTE : null;
}

// Delay before each no-reply nudge, as ms-after-sent. The list length also sets
// how many nudges are sent. Prod default 2d/4d; compressed orgs use FOLLOWUP_MINUTES.
export function followupDelaysMs(orgId: string | null | undefined): number[] {
  if (!usesCompressed(orgId)) return PROD_FOLLOWUP_DELAYS_MS;
  return envFollowupDelaysMs() ?? PROD_FOLLOWUP_DELAYS_MS;
}

// Delay before each call task, as ms-after-the-RFQ-was-sent. The list length also
// sets how many call tasks are raised. Prod default 1d/5d; compressed orgs use
// CALL_TASK_MINUTES. Stage 1 is an intro call and fires whether or not the
// supplier replied; every later stage is silence-only (see call-tasks.ts).
export function callTaskDelaysMs(orgId: string | null | undefined): number[] {
  if (!usesCompressed(orgId)) return PROD_CALL_TASK_DELAYS_MS;
  return envCallTaskDelaysMs() ?? PROD_CALL_TASK_DELAYS_MS;
}

// How long outreach waits for a supplier's sibling materials to finish enriching
// before sending anyway. Prod default 7d; compressed orgs use OUTREACH_COMPILE_WAIT_MINUTES.
export function compileWaitMs(orgId: string | null | undefined): number {
  if (!usesCompressed(orgId)) return PROD_COMPILE_WAIT_MS;
  return envCompileWaitMs() ?? PROD_COMPILE_WAIT_MS;
}
