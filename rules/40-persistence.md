# Persistence: never give up, never quietly stop short

## PERS-01 — Only a structural verdict is terminal

A failure earns another attempt by default. Terminal means the answer will not
change however many times we ask: not authorised, rejected as malformed, out of
credit. A 404, a timeout, a rate limit, a parse failure and an empty response
are all repairable and all get retried with backoff, forever.

Cap the SPEND, never the number of attempts.

Sam's standing position, first for contacts and restated on 2026-08-05 when a
capped one-off requeue was proposed for the marketplace price pull: "but you
shouldnt give up or time out". The cap had frozen 888 price-pull leads, of
which only about 73 were genuinely unpullable. 289 were pointed at the wrong
URL and 89 were our own reader or API failures, so the attempt cap had
converted our own bugs into a permanent verdict about the supplier.

Three mechanics follow from it and are easy to get wrong:

- Back off on a ladder (a day, three days, a week, a fortnight, monthly cap)
  rather than counting attempts. Bounded cost, unbounded persistence.
- A failure that is not a verdict about the page (5xx, overload, timeout, our
  own reader returning no JSON) must NOT advance the backoff. Nothing was
  learned, so the next try goes at full speed.
- Order retries after never-attempted work (`nulls first` on the last-attempt
  timestamp) so a growing retry pool can never starve fresh discovery.

Each retry persists what it learned, such as a repaired source URL, so
attempts compound instead of repeating the same failure.

**Enforcement:** Guard — `src/lib/retry-verdict.ts` `classifyFailure`.
Check owed — `retry/verdict-must-use-shared-classifier`: only three call sites
use it and two hand-rolled classifiers remain. See `OUTSTANDING.md`.

## PERS-02 — "Needs a human" is a display flag, never a queue exit

Marking a record as needing attention must not remove it from the work queue.
If it leaves the queue it stops being retried and nobody ever sees it again.

**Enforcement:** Check owed — `queues/flag-must-not-exit-queue`.

## PERS-03 — A zero-result pass is never "this market is empty"

Zero is indistinguishable from a naming miss, a bad query, a silent transport
failure or a crashed run. A dry pass is requeued and retried like a crash. No
source may write a terminal "searched, nothing here" state on a single zero.

Any NEW discovery source has to make this choice itself; the guard is
per-source today.

**Enforcement:** Check owed — `discovery/zero-must-not-be-terminal`, over
one shared dry-pass helper. Honoured per source today. See `OUTSTANDING.md`.

## PERS-04 — Retry limits are a spend control, and must be named

Where a source does bound retries, the bound must be stated in this folder and
in the run summary. A silent bound is a break of PERS-01.

Currently bounded: the SourceReady discovery path gives up after three
consecutive dry passes. This is a deliberate credit control, recorded here so
it is not mistaken for the rule.

**Enforcement:** Check owed — `retry/bound-must-be-declared`: a bounded
retry must name its bound here and in the run summary.

## PERS-05 — Never give up on a lead with no contact

A lead with no channel stays in the retry queue permanently. A lead promoted
past raw that has a website but still no email must also keep being retried; a
promotion must never be the thing that ends the search.

**Enforcement:** Check owed — `outreach/contactless-must-park-not-drop`. A
scheduled sweep compensates today, which is a workaround under META-03 and
is named in `OUTSTANDING.md`. This used to name OUT-02's check. They are not
the same break: OUT-02 is a storefront that was never given a channel, PERS-05
is a direct supplier actively set to `dropped` so the re-queue cannot see it.
Sharing one id meant guarding either one would report both as held.

## PERS-06 — No hidden caps on a worklist

Never silently truncate. Page to completion. An accidental cut at the database
page size is caught by the guard; a deliberate window is not, so if a run or a
view is bounded, name the bound where it is visible ("newest 50 of 312") and
say in the run summary what was left behind.

Do not weigh "it might get slow" against completeness and quietly pick the cap.
Make it complete and raise the cost if it is real (AUTO-03).

Sam, 2026-08-07, after the escalation lists were found showing 1,000 of
Tenkara's 2,259 open cases with nothing on the page saying so, while the Call
Tracker read "No calls are due right now" with 12 calls owed: "we need this
information to be high trust. you cannot be making such decisions to hide
information or cap info." The failure mode is not slowness. It is that a
missing escalation looks exactly like a handled one, so the operator trusts an
empty tab.

Two mechanics that decide whether paging actually works: page over a stable
total order, because `created_at desc` alone is not one and ties shift between
pages, and push per-tab filters into the query rather than filtering in JS, or
surfaces sharing a loader starve each other inside one response.

**Enforcement:** Guard for the accidental cut — `src/lib/supabase-paging.ts`
`selectAllPaged` and `src/lib/supabase/truncation-guard.ts`,
`reads/client-must-guard-truncation`. Check owed —
`reads/limit-must-report-remainder` for deliberate windows.

## PERS-07 — A withheld price is a job, not an outcome

The reason is stored so somebody can work the row. That only means anything if
the flagged rows appear somewhere a person looks. A withheld price that is
written and never surfaced is a silent failure wearing a reason code.

**Enforcement:** Audit owed — a daily count of withheld prices with no
surface, plus the surface itself on the client's own tab (see
`80-control-room.md`). See `OUTSTANDING.md`.

## PERS-08 — The record of a failure is never proof of success

Parking something for triage produces artefacts: a case, a clarification draft,
a ledger row. None of them are the work. An idempotency check that cannot tell
the two apart turns one miss into a permanent one, because every later attempt
sees the artefact, calls the job done, and stops — including the attempt made
after the original bug was fixed.

The inbound router did exactly this. It skipped any message that already had a
draft naming it, and the clarification draft the router itself stages on a
parked message names it. So the ORG-11 casualties stayed parked after ORG-11
was fixed: the replay matched the supplier correctly and then returned
"deduped" against the evidence of the very failure it had just repaired. Four
California Chemicals threads were replayed on 2026-08-20 and produced nothing
for this reason.

Where a check asks "have we already handled this", it must name the artefacts
that mean handled, never assume anything present means handled. And it must not
fail open: a `maybeSingle` read of a set that can hold two rows returns neither,
which is the opposite answer.

The artefacts also have to be retired once the message is answered, or they
outlive the failure they describe. The clarification draft is the dangerous
half: it is review-only, it sits in the operator's queue, and sending it asks a
supplier who they are on a thread we have just replied to properly. One went out
to Reroot on 2026-08-18 that way. Retiring it is local bookkeeping and must stay
that way — Tenkara holds one draft slot per conversation, so the reply has
already overwritten the clarification in the email app, and deleting the draft
there would delete the reply.

**Enforcement:** Guard — the reply-drafted check in `src/lib/tenkara-inbound.ts`
excludes `unmatched_inbound_clarification` and `retireUnmatchedTriage` closes
the case and the draft on a successful match;
`replies/idempotency-must-exclude-triage-artefacts` fails the build if the check
stops distinguishing them or the retirement is dropped.

## PERS-09 — A paced job stops itself and says where it stopped

Any run whose length is set by something outside the code (a rate limit, a
per-item API call, a queue that grew) must carry a deadline, stop starting work
when it passes, and report the remainder plus a cursor to resume from. Being
killed by the platform is not a stopping condition: the run is recorded as
`function timed out before completion` with no counts at all, so the work it
DID do is invisible, and the next run has no idea where to pick up.

The thread owner sync learned this twice. Its deadline was checked only between
clients, which bounds the number of clients and not the work, so one client
with a thousand open threads to push (paced at 45 assignee writes a minute, so
twenty-two minutes) overran the function ceiling on 2026-08-20 and reported
nothing. A bounded run that says "612 left for the next run" is a healthy run.
A killed one is an outage you cannot measure.

The same deadline belongs on the interactive path, and it should be short
there. A lane edit re-derives every thread on the client, and the operator is
waiting on the response; the local writes are what make Control Room correct
and they are not paced, so the mirror gets a budget and the nightly walk
finishes it.

**Enforcement:** Guard — `deadlineAt` on `syncOrgThreadOwners`
(`src/lib/sync-thread-owners.ts`), threaded into both push loops, with
`unpushed` in the run summary and the re-assert cursor rewound to the last
thread actually pushed; `INTERACTIVE_SYNC_BUDGET_MS` at the server-action call
sites. Check owed for the class — `runs/paced-loop-must-carry-deadline`, so a
new per-item push loop with no deadline fails the build. See `OUTSTANDING.md`.

## PERS-10 — Blocked is not empty

A 403, 429 or 401 says nothing about what a page contains. It must be recorded
as blocked, distinctly from "fetched fine, publishes nothing", and it never
counts toward a terminal verdict. Only the second is evidence about the
supplier; the first is evidence about us.

Collapsing the two hides our own faults inside the client's data. On 2026-08-05
Agent 06 parsed 403 bodies like any other page, so 1,751 residual leads had
every page "fail" with nothing recording that most of them were refusals
triggered by our own crawler user agent (COMM-09). The same shape produced the
storefront drop in `OUTSTANDING.md`, which is why this is a rule and not a
note on one agent.

**Enforcement:** Check owed — `fetch/blocked-must-not-read-as-empty`: a non-2xx
response may not reach a content parser, and the blocked reason is stored.
See `OUTSTANDING.md`.
