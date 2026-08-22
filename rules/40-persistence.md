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

**Enforcement:** Guard — `src/lib/retry-verdict.ts` `classifyFailure`, held by
`retry/no-inline-classifier`: the classifier must stay exported, the two loops
that used to hand-roll their own (the Browserbase pull and the Tenkara owner
push) must call it, the browser pull may not invent a `login_required` verdict
of its own, and a second rate-limit regex anywhere in a runtime file fails the
build.

Two things the classifier says that look like exceptions and are not. A 401 or
403 is terminal for an API call and retryable for a page fetch — the caller
passes `scope: "page"` when it is a site refusing a visitor rather than a
service refusing our credentials. And exhausting `maxAttempts` returns terminal
with a `_attempts_exhausted` reason: that ends the loop, it does not settle the
question, and requeueing for a later run stays the caller's decision.

The owner push keeps one local verdict on purpose: 404/403/422 from Tenkara mean
the conversation is gone, not that the request failed. It is argued for in the
comment beside it and measured at 123 threads.

## PERS-02 — "Needs a human" is a display flag, never a queue exit

Marking a record as needing attention must not remove it from the work queue.
If it leaves the queue it stops being retried and nobody ever sees it again.

A mark may move a record to a person's queue rather than out of every queue —
a lead parked against an escalation case is still work, it is waiting on a
person. That parking is a loan and not a disposal: when the case is dismissed
or resolved, the lead comes back. An operator's own verdict is different and
stands; this rule is about the machine's marks, not a person's decision.

**Enforcement:** Guard — `queues/flag-must-not-exit-queue`, four mutations. No
read may filter the flagged rows away, and a lead may only be parked against a
case through `src/lib/lead-queue-holds.ts`, which records the case id and whose
`releaseClosedHolds` gives the lead back the moment that case stops being open.
Both halves are checked: deleting the sweep fails the build, and so does
leaving it uncalled.

## PERS-03 — A zero-result pass is never "this market is empty"

Zero is indistinguishable from a naming miss, a bad query, a silent transport
failure or a crashed run. A dry pass is requeued and retried like a crash. No
source may write a terminal "searched, nothing here" state on a single zero.

A pass has three outcomes, not two, and every break of this rule is the same
mistake: two of them get collapsed.

- **found** — the source answered and named something.
- **dry** — the source answered and named nothing. Retryable, on a bound.
- **infra** — the source did not answer. It costs nothing and writes nothing.

Collapsing infra into dry spends a real attempt on an outage. Collapsing dry
into found writes the terminal state on a single zero. Nine sites did one or
the other, and the shapes are worth recognising: a 200 whose body is an error
envelope read as an empty market; an empty answer cached with no expiry; a
crashed re-check laundered into an operator finding that then locked the row
out of every future run; a page that loaded but printed nothing treated as a
page that printed "nothing is published"; a 403 rested for sixty days as if it
had been read.

Any NEW discovery source has to make this choice itself, but it makes it with
the shared helper rather than its own copy.

**Enforcement:** Guard — `src/lib/dry-pass.ts` (`passOutcome`,
`advanceDryPass`, `retryAfter`, `rowsOrThrow`) and
`discovery/zero-must-not-be-terminal`, which fails the build if the helper
stops naming all three outcomes, if any of the six sites stops going through
it, or if the marketplace re-check goes back to writing a crash as a finding.

## PERS-04 — Retry limits are a spend control, and must be named

Where a source does bound retries, the bound must be stated in this folder and
in the run summary. A silent bound is a break of PERS-01.

Every bound in the fleet, by name, in two groups: the dry-pass bounds, which
count across runs, and the in-run attempt ceilings, which are a spend control on
one synchronous request and never a verdict about the work.

The cross-run bounds are gathered in `DRY_PASS_LIMITS` in `src/lib/dry-pass.ts`,
all of them 3, all of them counting *consecutive dry passes* — a pass the source
answered and named nothing on. An infrastructure failure advances none of them,
and a single find resets the line of enquiry to open. Each is a spend control on
a repeated call that has so far bought nothing:

- `DRY_PASS_LIMITS.sourceready_search` (3) — stop re-querying a material against
  SourceReady, which is billed per search. Formerly the constant
  `SOURCEREADY_MAX_DRY_PASSES`, and still the only bound that can end a line of
  enquiry outright.
- `DRY_PASS_LIMITS.aggregator_index` (3) — stop re-reading an aggregator index
  page no sellers could be read off. Each attempt is a model page-read.
- `DRY_PASS_LIMITS.supplier_web_fill` (3) — stop re-reading a supplier site that
  was reachable but printed none of the missing fields. On exhaustion the fields
  are marked `not_published`, which is a finding, not a failure.
- `DRY_PASS_LIMITS.document_page` (3) — stop re-fetching a document page that
  answered with a wall (403/429) rather than documents. Paired with the retry
  ladder below, so the last word is a cooldown, not a stop.
- `DRY_PASS_LIMITS.material_aliases` (3) — stop re-asking the model for trade
  synonyms for a material it has already found none for three times.

`BLOCKED_RETRY_DAYS` (1, 3, 7) in the document agent is the ladder, not a bound:
it lengthens the wait and never ends it.

The in-run ceilings, none of which ends a line of enquiry:

- `MAX_ATTEMPTS` in `src/lib/tenkara-readonly.ts` (3) — the Tenkara pooler
  hangs intermittently and each failure rebuilds the pool.
- `MAX_ATTEMPTS` in `src/lib/thread-tailor.ts` (3) — on exhaustion the draft is
  flagged `needsTailorRetry` and picked up by a later run, so nothing stops.
- `MAX_RETRIES` in `contact-read.ts` and `storefront-resolve.ts` (1 each) —
  a per-lead model-call ceiling, so one stuck call cannot eat the lead budget.
- `RATE_LIMIT_RETRIES` in `shopify-feed.ts` (2).
- `FLAG_AFTER_ATTEMPTS` (3) — not a retry bound at all: it is how many times
  `needs_review` is seen before a case is opened. Retries continue.

A bound reached used to be visible only as a counter in a jsonb column. No run
said it out loud, so a material we had stopped asking about looked exactly like
a source that had gone quiet, and the spend control was unauditable from the
outside. `advanceDryPass` now returns the sentence on exhaustion — written once,
so five bounds cannot describe themselves five different ways — and every caller
puts it in its run summary. `runSupplierWebFill` has no logger of its own, so it
hands the notes up with its stats.

**Enforcement:** Guard — `retry/bound-must-be-declared`: a constant whose name
says it bounds attempts, retries or dry passes must be named in this file, the
shared `DRY_PASS_LIMITS` keys must be named here too, `advanceDryPass` must
return its exhaustion note, and any caller that advances a bound without
surfacing that note fails the build.

## PERS-05 — Never give up on a lead with no contact

A lead with no channel stays in the retry queue permanently. A lead promoted
past raw that has a website but still no email must also keep being retried; a
promotion must never be the thing that ends the search.

"Retry queue" is not a figure of speech: `requeue_parked_contact_leads` selects
on `status = 'active' and stage = 'enriched'`. Setting the lead to `dropped` is
therefore not a label, it is removal from the only path that tries again. Park
it — active, at `enriched`, stamped `outreach_parked_at` so it does not sit in
front of an operator.

Nothing else was looking. The guessed-combo and provider waterfall all run in
Agent 06 upstream, so by the time outreach sees a lead the search has already
failed; outreach performs no lookup of its own, it only reads the stored
address. The `contact-finder-agent` skill would re-attempt, but nothing
schedules it and its own query filters on `status = 'active'`, so it could not
see a dropped lead either. There was no compensating sweep — checked
2026-08-20.

**Enforcement:** Guard — `outreach/contactless-must-park-not-drop`. This used
to name OUT-02's check. They are not the same break:
OUT-02 is a storefront that was never given a channel, PERS-05 is a direct
supplier actively set to `dropped` so the re-queue cannot see it. Sharing one id
meant guarding either one would report both as held.

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

**Enforcement:** Guard, in two halves. The accidental cut —
`src/lib/supabase-paging.ts` `selectAllPaged` and
`src/lib/supabase/truncation-guard.ts`, `reads/client-must-guard-truncation`.
The deliberate window — `reads/limit-must-report-remainder`, which fails any
capped read of a work table that does not carry its own remainder out.
`src/lib/capped-read.ts` is the runtime half (PostgREST returns the true count
on the same request, so knowing what was left behind is free) and
`src/components/showing-note.tsx` the page half. A window that genuinely hides
no work is waived in the check's `DECLARED_WINDOWS`, keyed by file *and* by the
exact constant, so renaming or moving it revokes the waiver.

## PERS-07 — A withheld price is a job, not an outcome

The reason is stored so somebody can work the row. That only means anything if
the flagged rows appear somewhere a person looks. A withheld price that is
written and never surfaced is a silent failure wearing a reason code.

**Enforcement:** Audit — Agent 26 counts withheld prices carrying no reason
every morning and reports them with the oldest date. On the day it shipped all
19 withheld prices in the system had no reason recorded, so the count is a real
measure and not a formality. Check owed for the second half: the surface itself
on the client's own tab (UI-06). Until that exists a person still has to read
the audit to find these rows, which is why the audit is the weaker of the two.
See `OUTSTANDING.md`.

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

**Enforcement:** Guard — `fetch/blocked-must-not-read-as-empty`, in three
parts, because the rule breaks at two different points and the code broke at
both while looking correct.

The first part derives the fetchers from the corpus instead of listing them: a
function returning both an `ok` flag and a body is a fetcher, so the seventh
one written is covered the day it exists, and every call site must read that
flag. The other two are anchored on the only two places in the fleet that parse
fetched HTML, and assert the refusal is acted on and not merely read. Both were
breaking this rule on 2026-08-20 while consulting `ok` correctly elsewhere in
the same file: the storefront resolver parsed a challenge page as the listing,
and the enrichment crawl set its `blocked` flag and then ran the extractors
over the refusal's body anyway. Fixed with the check.

What is still not covered: a fetcher whose refusal is read and stored but whose
retry treats it as a verdict. That is PERS-01's half of the same failure.
