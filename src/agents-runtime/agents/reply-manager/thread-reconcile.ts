import type { createAdminClient } from "@/lib/supabase/admin";
import { getTenkaraConversationDetails } from "@/lib/tenkara";
import { handleInboundReply } from "@/lib/tenkara-inbound";

// Reconciles tracked Tenkara threads against what we actually processed.
//
// Tenkara only fires message.received for conversations our agents already
// touched. When a supplier replies on a separate thread (a fresh subject, an
// inquiry-form auto-thread, a colleague starting a new mail) that conversation
// is not agent-touched, so no webhook is ever delivered. An operator then MERGES
// that thread into the agent's thread — and a merge MOVES message rows between
// conversations in place, emitting no event at all. Both halves are silent, so a
// real reply (with its quote and attachments) lands in a thread we track while
// our records still read as silence, and Agent 15 escalates the supplier to a
// phone call.
//
// The messages are physically in the TARGET conversation once merged, and the
// target is a thread we already track by thread_id. So polling our own tracked
// threads for unprocessed inbound messages catches merges, missed webhooks and
// out-of-thread replies with one mechanism, without needing a merge webhook.

type Admin = ReturnType<typeof createAdminClient>;

export interface ReconcileDeps {
  agentId: string;
  runId: string;
  log: (message: string, opts?: Record<string, any>) => Promise<void> | void;
}

export interface ReconcileResult {
  threadsChecked: number;
  replayed: number;
  drafted: number;
  failed: number;
  unreadable: number;
  mergedShells: number;
  // Older unseen messages skipped because a newer one from the same sender
  // supersedes them. Ledgered, never replayed.
  superseded: number;
  budgetExhausted: boolean;
  // Threads whose next_check_at is already in the past at the END of the run.
  // This is the honest coverage signal: if it climbs run over run the cadence is
  // writing cheques the read budget cannot cash.
  backlog: number;
  oldestDueMinutes: number | null;
}

// What one thread's pass produced. The sweep sums these; the on-demand
// "draft a reply now" button in the Control Room shows them to the operator.
export interface ThreadPassResult {
  checked: boolean;
  unreadable: boolean;
  rateLimited: boolean;
  mergedShell: boolean;
  replayed: number;
  drafted: number;
  failed: number;
  superseded: number;
  budgetExhausted: boolean;
  // Per-message outcome strings ("drafted", "no_draft", a reason, an error).
  outcomes: string[];
}

// Tenkara allows 60 conversation reads/minute across everything we run, so the
// sweep takes half and leaves the rest for the reply drafter and price pulls.
const READ_INTERVAL_MS = 2_000;
// Agent 15 runs every 5 minutes; stop well inside that so runs never overlap, and
// leave room for the no-reply sweep that follows in the same invocation.
const TIME_BUDGET_MS = 200_000;
const MAX_THREADS_PER_RUN = 120;
// A merged shell is followed to its live target; the cap stops a cycle or a long
// chain from spinning. Tenkara resolves up to five hops on its own draft writes.
const MAX_MERGE_HOPS = 5;
// A claim is taken before the replay so a dying invocation cannot double-draft.
// The cost is that a claim left behind by an invocation that died mid-replay
// would strand that message forever, so a claim this old is considered abandoned
// and retried. Comfortably longer than the function's own 800s ceiling.
const STALE_CLAIM_MS = 20 * 60_000;

// Cadence tiers, keyed on how recently anyone wrote on the thread. The webhook is
// still the primary path — this sweep is the safety net for when it never fires —
// so even the hot tier does not need minute-level polling.
const HOT_AGE_DAYS = 21;
const WARM_AGE_DAYS = 60;
const HOT_INTERVAL_MIN = 60;
const WARM_INTERVAL_MIN = 12 * 60;
const COLD_INTERVAL_MIN = 7 * 24 * 60;
// A thread that just yielded an unseen reply is live in a way its timestamps may
// not show yet; look again soon rather than waiting out the full tier.
const FOUND_INTERVAL_MIN = 15;
// A thread Tenkara says does not exist (deleted, or an id that was never a
// conversation). It cannot be left unscheduled: an unscheduled thread stays at
// the head of the due queue forever and eats every run's read budget, which is
// exactly what happened here — ~2,800 threads were "due" while the sweep checked
// zero real ones for days. So a definitive miss is scheduled far out rather than
// retried immediately, and a transient one is retried soon.
const GONE_INTERVAL_MIN = 7 * 24 * 60;
const TRANSIENT_MISS_INTERVAL_MIN = 60;

// Placeholder ids Agent 04 writes when a lead has no real conversation yet
// ("blocked:..."). They are not Tenkara conversations and never will be, so they
// must never enter the reconcile rotation.
const REAL_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nextCheckAt(lastMessageAt: string | null, foundSomething: boolean): string {
  let minutes: number;
  if (foundSomething) {
    minutes = FOUND_INTERVAL_MIN;
  } else {
    const ageDays = lastMessageAt
      ? (Date.now() - new Date(lastMessageAt).getTime()) / 86_400_000
      : Infinity;
    minutes = ageDays <= HOT_AGE_DAYS ? HOT_INTERVAL_MIN : ageDays <= WARM_AGE_DAYS ? WARM_INTERVAL_MIN : COLD_INTERVAL_MIN;
  }
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// Registers any tracked thread the cadence table has not seen yet, then returns
// the most-overdue slice. Threads with a null next_check_at (never checked) sort
// first; that null set drains permanently on first check, so unlike an
// always-refilling null column it cannot starve the rotation.
async function claimDueThreads(admin: Admin, limit: number): Promise<string[]> {
  // PostgREST caps an unbounded select at 1000 rows; there are already more
  // draft_references than that, so page explicitly or the tail of the fleet is
  // silently never reconciled.
  const PAGE = 1000;
  const tracked = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const { data: refs, error } = await admin
      .from("draft_references")
      .select("thread_id")
      .eq("email_client", "rod_app")
      .not("thread_id", "is", null)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`thread list failed: ${error.message}`);
    for (const r of refs ?? []) {
      const id = (r as any).thread_id as string;
      if (REAL_THREAD_ID.test(id)) tracked.add(id);
    }
    if (!refs || refs.length < PAGE) break;
  }
  if (tracked.size === 0) return [];

  const { error: seedError } = await admin
    .from("tenkara_thread_reconcile")
    .upsert([...tracked].map((thread_id) => ({ thread_id })), { onConflict: "thread_id", ignoreDuplicates: true });
  if (seedError) throw new Error(`cadence seed failed: ${seedError.message}`);

  const { data: due, error: dueError } = await admin
    .from("tenkara_thread_reconcile")
    .select("thread_id")
    .or(`next_check_at.is.null,next_check_at.lte.${new Date().toISOString()}`)
    .order("next_check_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (dueError) throw new Error(`cadence read failed: ${dueError.message}`);
  return (due ?? []).map((r: any) => r.thread_id as string);
}

async function measureBacklog(admin: Admin): Promise<{ backlog: number; oldestDueMinutes: number | null }> {
  const now = new Date().toISOString();
  const { count } = await admin
    .from("tenkara_thread_reconcile")
    .select("thread_id", { count: "exact", head: true })
    .or(`next_check_at.is.null,next_check_at.lte.${now}`);
  const { data: oldest } = await admin
    .from("tenkara_thread_reconcile")
    .select("next_check_at")
    .not("next_check_at", "is", null)
    .lte("next_check_at", now)
    .order("next_check_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const oldestDueMinutes = oldest?.next_check_at
    ? Math.round((Date.now() - new Date(oldest.next_check_at).getTime()) / 60_000)
    : null;
  return { backlog: count ?? 0, oldestDueMinutes };
}

// Reads a thread, following a merge shell to the conversation that now holds the
// messages. Returns the live conversation id alongside its contents.
async function readLiveThread(threadId: string) {
  let currentId = threadId;
  let mergedInto: string | null = null;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    const details = await getTenkaraConversationDetails(currentId, { retryOn429: true });
    if (!details.found || !details.mergedInto || details.mergedInto === currentId) {
      return { details, liveId: currentId, mergedInto };
    }
    mergedInto = details.mergedInto;
    currentId = details.mergedInto;
    await sleep(READ_INTERVAL_MS);
  }
  const details = await getTenkaraConversationDetails(currentId, { retryOn429: true });
  return { details, liveId: currentId, mergedInto };
}

// One thread's pass: read it (following merge shells), find inbound messages we
// never processed, and replay them through the reply drafter.
//
// This is the ONLY place that logic lives. The scheduled sweep loops over it and
// the operator's "draft a reply now" button calls it for a single thread, so a
// manual re-draft can never drift from what the agent does on its own.
//
// opts.force re-processes the newest inbound message even though the ledger says
// we already handled it. That is exactly the operator's case: the agent looked at
// the reply and produced nothing, and a human wants it tried again.
export async function reconcileThread(
  admin: Admin,
  deps: ReconcileDeps,
  threadId: string,
  opts: { deadline?: number; force?: boolean } = {}
): Promise<ThreadPassResult> {
  const deadline = opts.deadline ?? Infinity;
  const out: ThreadPassResult = {
    checked: false, unreadable: false, rateLimited: false, mergedShell: false,
    replayed: 0, drafted: 0, failed: 0, superseded: 0, budgetExhausted: false, outcomes: [],
  };

  let live: Awaited<ReturnType<typeof readLiveThread>>;
  try {
    live = await readLiveThread(threadId);
  } catch (e: any) {
    await deps.log(`Thread ${threadId} read threw: ${e?.message ?? e}`, { level: "warn", step: "reconcile" });
    out.unreadable = true;
    out.outcomes.push(`read_failed: ${e?.message ?? e}`);
    return out;
  }
  const { details, liveId, mergedInto } = live;
  if (mergedInto) out.mergedShell = true;

  // A throttled or errored read is "unknown", never "no messages". Leaving
  // next_check_at untouched keeps the thread at the front of the queue instead
  // of rotating it to the back on the strength of a read that told us nothing.
  if (!details.found) {
    out.unreadable = true;
    out.rateLimited = !!details.rateLimited;
    out.outcomes.push(details.rateLimited ? "rate_limited" : "thread_unreadable");
    // Throttling tells us nothing about the thread, so leave it where it is in
    // the queue. Anything else is an answer of some kind and must be scheduled,
    // or this thread blocks the rotation permanently.
    if (!details.rateLimited) {
      const gone = details.status === 404 || details.status === 410;
      await admin
        .from("tenkara_thread_reconcile")
        .update({
          last_checked_at: new Date().toISOString(),
          last_status: details.status,
          next_check_at: new Date(
            Date.now() + (gone ? GONE_INTERVAL_MIN : TRANSIENT_MISS_INTERVAL_MIN) * 60_000
          ).toISOString(),
        })
        .eq("thread_id", threadId);
    }
    return out;
  }
  out.checked = true;

  const inbound = details.messages.filter((m) => m.is_outbound === false && m.id);
  let unseen: typeof inbound = [];
  // Message ids to capture pricing/documents from without composing a reply.
  let extractOnly = new Set<string>();
  // Messages we are deliberately re-processing despite an existing ledger row.
  const forced = new Set<string>();
  if (inbound.length > 0) {
    const { data: known, error: ledgerError } = await admin
      .from("inbound_message_ledger")
      .select("message_id,outcome,processed_at")
      .in("message_id", inbound.map((m) => m.id as string));
    if (ledgerError) throw new Error(`ledger read failed: ${ledgerError.message}`);
    const staleBefore = Date.now() - STALE_CLAIM_MS;
    const seen = new Set(
      (known ?? [])
        // A row still sitting at "claimed" long after any invocation could
        // still be alive is an abandoned claim, not a processed message.
        .filter((r: any) => !(r.outcome === "claimed" && Date.parse(r.processed_at) < staleBefore))
        .map((r: any) => r.message_id as string)
    );
    unseen = inbound.filter((m) => !seen.has(m.id as string));

    if (opts.force) {
      // The newest supplier message on the thread, whatever the ledger says: an
      // operator asking for a draft is asking about the message they can see.
      const newest = inbound.reduce<(typeof inbound)[number] | null>(
        (acc, m) => (!acc || (m.sent_at ?? "") > (acc.sent_at ?? "") ? m : acc),
        null
      );
      if (newest && !unseen.some((m) => m.id === newest.id)) {
        unseen = [...unseen, newest];
        forced.add(newest.id as string);
      }
    }

    // A thread can carry months of unseen backlog (one supplier here had 14).
    // Replaying each in turn drafts a reply to a message that later ones already
    // superseded, overwrites the same single draft slot every time, and costs a
    // model call plus attachment parsing per message. Only the NEWEST unseen
    // message per sender is worth a reply. Per SENDER, not per thread, because a
    // merged thread carries several people and each one's latest still needs an
    // answer. The rest are ledgered so they are never reconsidered.
    const newestPerSender = new Map<string, string>();
    for (const m of unseen) {
      const who = (m.from_email ?? "").toLowerCase();
      const cur = newestPerSender.get(who);
      if (!cur || (m.sent_at ?? "") > cur) newestPerSender.set(who, m.sent_at ?? "");
    }
    const superseded = unseen.filter(
      (m) => (m.sent_at ?? "") !== newestPerSender.get((m.from_email ?? "").toLowerCase())
    );
    // A superseded message still has to be READ if it carries files: the quote
    // PDF, price sheet or CoA attached to it is just as real as the one on the
    // newest message, and nothing else will ever open it. Those get an
    // extract-only pass (pricing and documents captured, no reply composed).
    // Prose-only superseded messages need no pass at all, because the drafter
    // already pulls the whole thread as context when it answers the newest one.
    const toExtract = superseded.filter((m) => m.attachmentCount > 0);
    const proseOnly = superseded.filter((m) => m.attachmentCount === 0);
    if (proseOnly.length > 0) {
      await admin.from("inbound_message_ledger").upsert(
        proseOnly.map((m) => ({
          message_id: m.id as string,
          conversation_id: liveId,
          sender_email: m.from_email,
          outcome: "superseded",
        })),
        { onConflict: "message_id", ignoreDuplicates: true }
      );
    }
    // Only the prose-only ones are truly skipped; the rest still get read, and
    // are counted by `replayed` like any other processed message.
    out.superseded += proseOnly.length;
    // Oldest first, so the newest message is drafted last and its reply_detected
    // stamp is the one that sticks.
    unseen = [...toExtract, ...unseen.filter((m) => !superseded.includes(m))];
    extractOnly = new Set(toExtract.map((m) => m.id as string));
  }

  let replayedHere = 0;
  for (const m of unseen) {
    // A replay stages a draft (model call plus attachment parsing) and can run
    // tens of seconds, so the budget has to be checked per MESSAGE. Checking
    // only per thread let one busy thread overrun the whole invocation.
    if (Date.now() > deadline) {
      out.budgetExhausted = true;
      break;
    }
    const messageId = m.id as string;
    // Claim the message BEFORE replaying it. handleInboundReply stages a draft
    // and can be slow; if the invocation dies midway, the claim is what stops
    // the next run from drafting a second reply to the same supplier message.
    const claimedAt = new Date().toISOString();
    const { error: claimError } = await admin
      .from("inbound_message_ledger")
      .insert({
        message_id: messageId,
        conversation_id: liveId,
        sender_email: m.from_email,
        outcome: "claimed",
        processed_at: claimedAt,
      });
    if (claimError) {
      // 23505 means a row already exists. It is ours to take over only if it is
      // an abandoned claim; the conditional update is what keeps that takeover
      // atomic against a concurrent run doing the same thing.
      if (claimError.code !== "23505") throw new Error(`ledger claim failed: ${claimError.message}`);
      let update = admin
        .from("inbound_message_ledger")
        .update({ outcome: "claimed", processed_at: claimedAt, conversation_id: liveId })
        .eq("message_id", messageId);
      // A forced re-draft takes the row over whatever state it is in; that is
      // the whole point of the operator pressing the button.
      if (!forced.has(messageId)) {
        update = update.eq("outcome", "claimed").lt("processed_at", new Date(Date.now() - STALE_CLAIM_MS).toISOString());
      }
      const { data: reclaimed, error: reclaimError } = await update.select("message_id");
      if (reclaimError) throw new Error(`ledger reclaim failed: ${reclaimError.message}`);
      if (!reclaimed?.length) continue;
      if (!forced.has(messageId)) {
        await deps.log(`Reclaimed abandoned claim on ${messageId}`, { level: "warn", step: "reconcile" });
      }
    }
    replayedHere++;

    out.replayed++;
    let outcome = "replayed";
    let body: Record<string, any> = {};
    try {
      const res = await handleInboundReply(admin, {
        conversation_id: liveId,
        message_id: messageId,
        from: m.from_name ? `${m.from_name} <${m.from_email}>` : (m.from_email ?? ""),
        subject: m.subject,
        body_text: m.body_text,
        body_html: m.body_html,
        received_at: m.sent_at,
        to_email: m.to?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null,
        email_account_id: details.emailAccountId,
      }, { extractOnly: extractOnly.has(messageId) });
      body = res.body ?? {};
      if (res.status >= 400) {
        outcome = "error";
        out.failed++;
      } else if (body.drafted) {
        outcome = "drafted";
        out.drafted++;
      } else {
        outcome = String(body.reason ?? Object.keys(body)[0] ?? "no_draft");
      }
      await deps.log(
        `Replayed unseen reply from ${m.from_email} on ${liveId}: ${outcome}`,
        { level: outcome === "error" ? "warn" : "info", step: "reconcile" }
      );
    } catch (e: any) {
      outcome = "threw";
      body = { error: e?.message ?? String(e) };
      out.failed++;
      await deps.log(`Replay threw for ${messageId}: ${body.error}`, { level: "warn", step: "reconcile" });
    }
    out.outcomes.push(outcome);

    await admin
      .from("inbound_message_ledger")
      .update({ outcome, result: body, processed_at: new Date().toISOString() })
      .eq("message_id", messageId);
  }

  const lastMessageAt = details.messages.reduce<string | null>(
    (acc, m) => (m.sent_at && (!acc || m.sent_at > acc) ? m.sent_at : acc),
    null
  );
  // Ran out of budget partway through this thread's unseen messages: the rest
  // are still unreplayed, so leave next_check_at where it is to keep the thread
  // at the front of the queue rather than rotating it to the back half-done.
  const finished = replayedHere >= unseen.length;
  await admin
    .from("tenkara_thread_reconcile")
    .update({
      last_checked_at: new Date().toISOString(),
      ...(finished ? { next_check_at: nextCheckAt(lastMessageAt, unseen.length > 0) } : {}),
      last_message_at: lastMessageAt,
      last_status: details.status,
      merged_into: mergedInto,
      replayed_last: replayedHere,
    })
    .eq("thread_id", threadId);

  return out;
}

export async function runThreadReconcile(deps: ReconcileDeps, admin: Admin): Promise<ReconcileResult> {
  const startedAt = Date.now();
  const result: ReconcileResult = {
    threadsChecked: 0, replayed: 0, drafted: 0, failed: 0,
    unreadable: 0, mergedShells: 0, superseded: 0, budgetExhausted: false,
    backlog: 0, oldestDueMinutes: null,
  };

  const threads = await claimDueThreads(admin, MAX_THREADS_PER_RUN);
  if (threads.length === 0) return { ...result, ...(await measureBacklog(admin)) };

  for (const threadId of threads) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      result.budgetExhausted = true;
      break;
    }

    const pass = await reconcileThread(admin, deps, threadId, { deadline: startedAt + TIME_BUDGET_MS });
    if (pass.checked) result.threadsChecked++;
    if (pass.unreadable) result.unreadable++;
    if (pass.mergedShell) result.mergedShells++;
    result.replayed += pass.replayed;
    result.drafted += pass.drafted;
    result.failed += pass.failed;
    result.superseded += pass.superseded;
    if (pass.rateLimited) {
      await deps.log("Tenkara read throttled; ending sweep early", { level: "warn", step: "reconcile" });
      result.budgetExhausted = true;
      break;
    }
    if (pass.budgetExhausted) {
      result.budgetExhausted = true;
      break;
    }
    await sleep(READ_INTERVAL_MS);
  }

  return { ...result, ...(await measureBacklog(admin)) };
}
