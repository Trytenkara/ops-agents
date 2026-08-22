import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPaged } from "@/lib/supabase-paging";
import { getOrgAssignmentContext, recordOwnerId } from "@/lib/operator-assignment";
import { setTenkaraConversationAssignee } from "@/lib/tenkara";
import { classifyFailure } from "@/lib/retry-verdict";

// Re-derive the owner of an org's OPEN threads and push it to the Tenkara inbox.
//
// Control Room derives an owner every time a tab renders, but the email app holds
// whatever was last pushed to it, so the two agree only for as long as the inputs
// to the derivation stay still. Change a lane, flip someone's desk from email to
// phone, or take someone out of the auto loop, and Control Room moves 100+ threads
// on the next page load while the inbox keeps showing the previous owner. That is
// exactly what operators report as "the email app and Control Room disagree":
// after Cal Chem's lanes were edited, 125 of 1,103 open threads named a different
// person in each place.
//
// The reset button (rebalanceOrgAssignments) already fixes this, but it also
// DELETES supplier claims, which is irreversible and far more than a lane toggle
// asked for. This is the narrow, non-destructive half: draft stamps and the Tenkara
// mirror only. No claims, no leads.
//
// Only work still in front of an operator is touched. A sent draft keeps its
// stamp: that is who the supplier will reply to.
const OPEN_DRAFT_STATUSES = ["staged", "blocked", "reviewed"];

const MIRROR_CONCURRENCY = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Drafts that never reached Tenkara park a synthetic id ("blocked:...",
// "form-inquiry:...") where a conversation id would go. There is nothing to
// push onto, and asking anyway returns a 500 the retry loop would dutifully
// repeat.
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Push one thread's owner to Tenkara, telling a temporary refusal apart from a
// permanent one. 429/5xx/network get backed off; a verdict does not.
//
// 404 is the one that matters at scale: a conversation the inbox no longer has
// (deleted there, or from an environment that is gone) can never accept an
// assignee, and there are 123 of them across the fleet. Counting those as
// failures made every nightly sweep report "partial" and spend three retries
// each on work that cannot succeed, which is exactly how a real Tenkara outage
// would get lost in the noise.
type PushOutcome = "pushed" | "gone" | "failed";

// Tenkara allows 60 assignee writes a minute and answers 429 past that. A burst
// of 36 at concurrency 6 got 12 through and 429ed the other 24 in seven seconds,
// which the old half-second backoff could not survive: the window is a MINUTE,
// so every retry landed inside the same exhausted window and the thread was
// written off as "the inbox did not accept" (80 of them per sweep).
//
// So the sweep paces itself below the limit rather than discovering it. Kept
// under 60 because draft staging pushes assignees on the same quota.
const RATE_PER_MIN = 45;
let windowStartedAt = 0;
let usedInWindow = 0;

async function rateGate(): Promise<void> {
  for (;;) {
    const now = Date.now();
    if (now - windowStartedAt >= 60_000) {
      windowStartedAt = now;
      usedInWindow = 0;
    }
    if (usedInWindow < RATE_PER_MIN) {
      usedInWindow++;
      return;
    }
    await sleep(windowStartedAt + 60_000 - now + 100);
  }
}

async function pushOwner(threadId: string, email: string, attempts = 3): Promise<PushOutcome> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await rateGate();
    const res = await setTenkaraConversationAssignee(threadId, email).catch(() => ({
      ok: false,
      status: 0,
    }));
    if (res.ok) return "pushed";
    if (res.status === 404 || res.status === 403 || res.status === 422) return "gone";
    // A 429 means somebody else spent the window, so wait for a fresh one rather
    // than spending this attempt on a request that cannot succeed.
    if (res.status === 429) {
      usedInWindow = RATE_PER_MIN;
      continue;
    }
    // Everything else goes through the shared classifier, so this loop cannot
    // grow a second idea of what is worth another attempt (PERS-01). The two
    // verdicts above are the deliberate exceptions and are argued for beside
    // them. What this adds: a 401 stops here instead of spending three attempts
    // on credentials that will not improve.
    const v = classifyFailure({ status: res.status }, { attempt, maxAttempts: attempts });
    if (v.verdict === "terminal") return "failed";
    await sleep(v.backoffMs);
  }
  return "failed";
}

// Returns the items that were never started, so a sweep that runs out of time
// can report the remainder instead of the caller inferring it.
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  stop?: () => boolean
): Promise<T[]> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        if (stop?.()) return;
        await fn(items[next++]);
      }
    })
  );
  return items.slice(next);
}

export interface ThreadOwnerSyncOptions {
  // Re-push threads that did NOT move, walking forward from `after` in id order.
  //
  // Needed because a thread only gets pushed on the run that moves it. If that
  // push failed at the time (Tenkara 429/5xx, or the process died mid-sweep, both
  // of which have happened), the stamp is right and every later run sees "already
  // correct" and never pushes again, so the inbox stays wrong indefinitely and
  // this sync reports a clean match. Re-asserting a rolling slice each day closes
  // that hole: the push is idempotent, so a thread that is already right costs one
  // call and changes nothing.
  reassert?: { limit: number; after?: string | null };
  // Epoch ms after which no further push is STARTED. Pushing is paced at 45
  // writes a minute, so the time a sweep takes is set by the inbox, not by us:
  // a client with a thousand open threads is twenty minutes of pushing however
  // fast the code is. Without this the sweep simply ran until the platform
  // killed the function, and a killed run records "function timed out" with no
  // counts at all, so the work it DID do was invisible and the next run had no
  // idea where to resume (2026-08-20: 16 minutes, no summary, nothing learned).
  // Stopping ourselves turns that into a partial run with a cursor.
  deadlineAt?: number;
}

export interface ThreadOwnerSyncResult {
  examined: number;
  moved: number;
  // Threads re-pushed although they had not moved, and how far the walk got.
  // Feed `cursor` back as `reassert.after` next run; null means it wrapped.
  reasserted: number;
  cursor: string | null;
  // Threads Control Room moved but Tenkara refused. Non-zero means the inbox is
  // still behind and the sync should be run again; it is reported rather than
  // thrown so a Tenkara outage cannot roll back a config change that already saved.
  mirrorsFailed: number;
  // Threads the inbox will never accept (404 gone, 403 not ours, 422 unknown
  // assignee). Kept apart from mirrorsFailed so a real outage still stands out.
  gone: number;
  // Pushes the deadline cut off. Non-zero means the inbox is behind on purpose
  // and the next run continues from `cursor`; it is not a failure.
  unpushed: number;
}

// What a sync started by a person in the UI is allowed to spend before it hands
// the rest to the nightly walk. A lane edit can move a thousand threads, which
// is twenty-two minutes of pushing at the inbox's rate: far past any server
// action's ceiling, so without a budget the edit appears to hang and then fails
// with the save already committed. Control Room is correct the moment the stamps
// are written, and those are not paced; only the inbox mirror is.
export const INTERACTIVE_SYNC_BUDGET_MS = 45_000;

export async function syncOrgThreadOwners(
  admin: SupabaseClient,
  orgId: string,
  opts: ThreadOwnerSyncOptions = {}
): Promise<ThreadOwnerSyncResult> {
  const result: ThreadOwnerSyncResult = {
    examined: 0,
    moved: 0,
    reasserted: 0,
    cursor: opts.reassert?.after ?? null,
    mirrorsFailed: 0,
    gone: 0,
    unpushed: 0,
  };
  const outOfTime = () => opts.deadlineAt != null && Date.now() >= opts.deadlineAt;
  const ctx = await getOrgAssignmentContext(admin, orgId);

  const drafts = await selectAllPaged<{
    id: string;
    supplier_id: string | null;
    thread_id: string | null;
    assigned_operator: string | null;
    metadata: any;
  }>((from, to) =>
    admin
      .from("draft_references")
      .select("id, supplier_id, thread_id, assigned_operator, metadata")
      .eq("org_id", orgId)
      .in("status", OPEN_DRAFT_STATUSES)
      .order("id")
      .range(from, to)
  ).catch(() => []);
  result.examined = drafts.length;

  type Thread = { id: string; threadId: string | null; operatorId: string };
  const moves: Thread[] = [];
  // Already stamped with the right owner. Control Room is correct for these; the
  // inbox is only presumed correct, which is what the re-assert walk checks.
  const settled: Thread[] = [];
  for (const d of drafts) {
    // Same helper the Thread Tracker renders with, so "the email app matches
    // Control Room" cannot become a claim about two separate copies of the rule.
    const owner = recordOwnerId(ctx, d, "email");
    // Derivation declining to own the thread leaves the stamp alone. Clearing it
    // would blank the only record of ownership for a client whose pool went empty.
    if (!owner) continue;
    if (owner === d.assigned_operator) {
      settled.push({ id: d.id, threadId: d.thread_id, operatorId: owner });
      continue;
    }
    moves.push({ id: d.id, threadId: d.thread_id, operatorId: owner });
  }

  for (const m of moves) {
    const { error } = await admin
      .from("draft_references")
      .update({ assigned_operator: m.operatorId })
      .eq("org_id", orgId)
      .eq("id", m.id);
    if (!error) result.moved++;
  }

  // One lookup for every operator we are about to push, instead of one per
  // thread: the same handful of people own hundreds of threads.
  const emailById = new Map<string, string>();
  const operatorIds = [...new Set([...moves, ...settled].map((t) => t.operatorId))];
  if (operatorIds.length) {
    const { data: users } = await admin.from("users").select("id, email").in("id", operatorIds);
    for (const u of users ?? []) if (u.email) emailById.set(u.id, u.email as string);
  }

  const pushable = (t: Thread) =>
    t.threadId && CONVERSATION_ID.test(t.threadId) && emailById.has(t.operatorId);

  // Mirror after the local writes, so a Tenkara failure leaves Control Room
  // correct and only the inbox behind. 429s back off rather than being dropped:
  // a swallowed mirror is indistinguishable from "this thread was already right".
  const leftOver = await mapLimit(
    moves.filter(pushable),
    MIRROR_CONCURRENCY,
    async (m) => {
      const outcome = await pushOwner(m.threadId!, emailById.get(m.operatorId)!, 4);
      if (outcome === "gone") result.gone++;
      else if (outcome === "failed") result.mirrorsFailed++;
    },
    outOfTime
  );
  result.unpushed += leftOver.length;

  // A move whose push never went out is exactly the hole the re-assert walk
  // exists to close, and it is now stamped, so it looks settled to every later
  // run. Spending the remaining time on the rolling walk instead would leave it
  // waiting for its turn, so stop here and let the next run take it.
  if (opts.reassert && opts.reassert.limit > 0 && !outOfTime()) {
    const after = opts.reassert.after ?? "";
    const pool = settled.filter((t) => pushable(t) && t.id > after);
    const slice = pool.slice(0, opts.reassert.limit);
    // Wrapping to null when the walk reaches the end, so the next run starts over
    // rather than sitting past the last id and re-asserting nothing forever.
    result.cursor = pool.length > slice.length ? slice[slice.length - 1].id : null;
    const unwalked = await mapLimit(
      slice,
      MIRROR_CONCURRENCY,
      async (t) => {
        const outcome = await pushOwner(t.threadId!, emailById.get(t.operatorId)!);
        if (outcome === "pushed") result.reasserted++;
        else if (outcome === "gone") result.gone++;
        else result.mirrorsFailed++;
      },
      outOfTime
    );
    result.unpushed += unwalked.length;
    // Resume where the clock stopped us, not past the threads we never pushed.
    if (unwalked.length) {
      const reached = slice.length - unwalked.length;
      result.cursor = reached > 0 ? slice[reached - 1].id : (opts.reassert.after ?? null);
    }
  }

  return result;
}
