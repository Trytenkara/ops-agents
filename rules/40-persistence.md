# Persistence: never give up, never quietly stop short

## PERS-01 — Only a structural verdict is terminal

A failure earns another attempt by default. Terminal means the answer will not
change however many times we ask: not authorised, rejected as malformed, out of
credit. A 404, a timeout, a rate limit, a parse failure and an empty response
are all repairable and all get retried with backoff, forever.

Cap the SPEND, never the number of attempts.

**Enforcement:** Guard — `src/lib/retry-verdict.ts` `classifyFailure`. Owed:
only three call sites use it and two hand-rolled classifiers remain. See
`OUTSTANDING.md`.

## PERS-02 — "Needs a human" is a display flag, never a queue exit

Marking a record as needing attention must not remove it from the work queue.
If it leaves the queue it stops being retried and nobody ever sees it again.

**Enforcement:** Honour.

## PERS-03 — A zero-result pass is never "this market is empty"

Zero is indistinguishable from a naming miss, a bad query, a silent transport
failure or a crashed run. A dry pass is requeued and retried like a crash. No
source may write a terminal "searched, nothing here" state on a single zero.

Any NEW discovery source has to make this choice itself; the guard is
per-source today.

**Enforcement:** Honour per source. Owed: one shared dry-pass helper. See
`OUTSTANDING.md`.

## PERS-04 — Retry limits are a spend control, and must be named

Where a source does bound retries, the bound must be stated in this folder and
in the run summary. A silent bound is a break of PERS-01.

Currently bounded: the SourceReady discovery path gives up after three
consecutive dry passes. This is a deliberate credit control, recorded here so
it is not mistaken for the rule.

**Enforcement:** Honour.

## PERS-05 — Never give up on a lead with no contact

A lead with no channel stays in the retry queue permanently. A lead promoted
past raw that has a website but still no email must also keep being retried; a
promotion must never be the thing that ends the search.

**Enforcement:** Honour. A scheduled sweep currently compensates for the gap,
which is a workaround under META-03 and is named in `OUTSTANDING.md`.

## PERS-06 — No hidden caps on a worklist

Never silently truncate. Page to completion. An accidental cut at the database
page size is caught by the guard; a deliberate window is not, so if a run or a
view is bounded, name the bound where it is visible ("newest 50 of 312") and
say in the run summary what was left behind.

Do not weigh "it might get slow" against completeness and quietly pick the cap.
Make it complete and raise the cost if it is real (AUTO-03).

**Enforcement:** Guard for the accidental cut — `src/lib/supabase-paging.ts`
`selectAllPaged` and `src/lib/supabase/truncation-guard.ts`,
`reads/client-must-guard-truncation`. Honour for deliberate windows.

## PERS-07 — A withheld price is a job, not an outcome

The reason is stored so somebody can work the row. That only means anything if
the flagged rows appear somewhere a person looks. A withheld price that is
written and never surfaced is a silent failure wearing a reason code.

**Enforcement:** Honour. Owed: the flagged set must appear on the client's own
tab (see `80-control-room.md`). See `OUTSTANDING.md`.
