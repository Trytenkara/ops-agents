# Outreach

## OUT-01 — Nothing auto-sends (see AUTO-06)

**Enforcement:** Honour — see AUTO-06.

## OUT-02 — Marketplace storefronts get drafted, on a different channel

Both direct suppliers and marketplace or aggregator storefronts are drafted.
They are not excluded from outreach. Only the CHANNEL differs: a storefront
gets a bulk-pricing inquiry through the aggregator path, a direct supplier gets
an email to a person.

"Directory host" as a terminal verdict applies to a search-results or listing
page that sells nothing, not to a storefront with a real seller behind it.

**Enforcement:** Honour.

## OUT-03 — Never guess a contact on a platform host (see DATA-05)

**Enforcement:** Honour — see DATA-05.

## OUT-04 — One email per supplier, one thread

A supplier with several matching materials gets one consolidated email, not one
per material. Multiple contacts at the same supplier go on one thread as To
plus copies, and replies preserve the copied recipients.

**Enforcement:** Honour.

## OUT-05 — No draft into an existing thread may ignore what was already said

Any body whose drafter did not compose against the thread is tailored to it at
staging. Template follow-ups otherwise re-ask for the price, pack size, lead
time and quantity the supplier already answered in prose. Thread context is
trimmed oldest-first; trimming the newest while claiming a full thread is
worse than no context.

A failure to load the thread is reported, never silently turned into a
context-free draft.

**Enforcement:** Guard — `src/lib/thread-context.ts`,
`src/lib/thread-tailor.ts`, `copy/staging-must-tailor-to-thread`.

## OUT-06 — Internal notes never reach a supplier

Call outcomes, operator notes, de-escalation notes, pasted meeting transcripts
and pipeline state are internal. A drafter once shipped "Unable to reach after
two call attempts" to a live supplier. A line filter cannot make raw internal
prose safe, so those fields stay in the case record and never enter a body at
all.

**Enforcement:** Guard — `src/lib/internal-notes.ts` `stripInternalNotes`
inside `sanitizeDraft`, `copy/sanitize-must-strip-internal-notes`.

## OUT-07 — Copy bans are applied at staging (see COMM-08)

**Enforcement:** Guard — `copy/staging-must-sanitize`.

## OUT-08 — Supplier asks are staggered

Do not ask a supplier for everything at once. Asks are spread across stages of
the conversation.

**Enforcement:** Honour.

## OUT-09 — Stalled conversations get chased

A conversation with no reply is followed up on a fixed cadence measured from
the last outbound message, not abandoned.

**Enforcement:** Honour.

## OUT-10 — A cancelled outreach must release its alias

Cancelling in bulk without deleting the email alias leaves a ghost address that
still receives replies nobody reads.

**Enforcement:** Honour.
