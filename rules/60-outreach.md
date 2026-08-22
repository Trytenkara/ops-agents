# Outreach

## OUT-01 — Nothing auto-sends (see AUTO-06)

**Enforcement:** See AUTO-06.

## OUT-02 — Marketplace storefronts get drafted, on a different channel

Both direct suppliers and marketplace or aggregator storefronts are drafted.
They are not excluded from outreach. Only the CHANNEL differs: a storefront
gets a bulk-pricing inquiry through the aggregator path, a direct supplier gets
an email to a person.

"Directory host" as a terminal verdict applies to a search-results or listing
page that sells nothing, not to a storefront with a real seller behind it. A
page that could not be read is not a page that sells nothing.

A listing URL is not the seller's website. Treating one as a website is how
this rule was broken without anyone excluding anything on purpose: measured
2026-08-20, 309 storefront leads sat parked out of outreach with no contact and
none had ever been attempted, because 204 of them "had a website" that was
alibaba.com, made-in-china.com or indiamart.com. The storefront resolver, built
to find the seller's own domain, skipped every one of them.

**Enforcement:** Guard — `outreach/no-terminal-drop-without-channel`. The
aggregator inquiry channel itself is still owed; see `OUTSTANDING.md`.

## OUT-03 — Never guess a contact on a platform host (see DATA-05)

**Enforcement:** See DATA-05.

## OUT-04 — One email per supplier, one thread

A supplier with several matching materials gets one consolidated email, not one
per material. Multiple contacts at the same supplier go on one thread as To
plus copies, and replies preserve the copied recipients.

**Enforcement:** Guard — `outreach/one-thread-per-supplier`: the consolidation
key must stay org-and-supplier only, and the single staging call must be fed the
whole group. Adding the material to the key is the regression to expect — it
looks like a fix for subject-line collisions and it sends one person four
emails. Agent 22's operator path is not covered by this check; it stages one
lead per call by design and avoids a second thread by CCing onto the existing
one, which no static check can tell apart from the fault.

## OUT-05 — No draft into an existing thread may ignore what was already said

Any body whose drafter did not compose against the thread is tailored to it at
staging. Template follow-ups otherwise re-ask for the price, pack size, lead
time and quantity the supplier already answered in prose. Thread context is
trimmed oldest-first; trimming the newest while claiming a full thread is
worse than no context.

A failure to load the thread is reported, never silently turned into a
context-free draft.

The tailoring model call is retried on any repairable failure, per PERS-01.
Named bound (PERS-04): **3 attempts inside one staging request**, backoff from
`classifyFailure`, capped at 4s. That is a spend control on a synchronous
request, not a verdict. A draft that exhausts them is staged untailored AND
flagged `metadata.thread_tailor_retry = true` so a later pass can redraft it; a
rewrite the output guardrail declines is NOT retried, because the model
answered and we rejected its answer.

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

## OUT-14 — Never offer to stop contacting a supplier

No draft volunteers to go away. "If the timing isn't right, just say the word
and I'll stop chasing" was live in the stalled-thread chase. We are the buyer,
with money, asking a seller for a price; handing them a scripted exit is how a
live supplier goes quiet for good.

Scope is narrow, and was narrowed on 2026-08-19 after a first version overreached
and started deleting ordinary courtesy. These are FINE and must not be stripped:
"say the word and", "no worries if", "if the timing isn't right", "if this isn't
a fit", "sorry to bother you", and "say the word and I'll take you off the list"
(signed off by ops on 2026-08-19). Only an outright offer to stop chasing goes:
"stop chasing", "stop following up", "stop emailing", "I'll leave you alone".

This is about the WORDING, not the cadence. The follow-up schedule is OUT-09 and
is deliberately unchanged.

**Enforcement:** Guard — `CONCESSION_STRIPS` in `src/lib/email-style.ts`, run
inside `sanitizeDraft` at the staging chokepoint so it covers model-written copy
as well as templates, plus rule 5 of the `src/lib/thread-tailor.ts` prompt;
`copy/sanitize-must-strip-concessions`.

## OUT-07 — Copy bans are applied at staging (see COMM-08)

**Enforcement:** Guard — `copy/staging-must-sanitize`.

## OUT-08 — Supplier asks are staggered

Do not ask a supplier for everything at once. Asks are spread across stages of
the conversation: commercial first (is this worth pursuing), then logistics
(how it packs and ships), then onboarding (who we transact with), at most three
asks per email. Only the earliest stage with anything outstanding is put in
front of the model, and nothing is lost — the missing set is recomputed from
live data on every reply, so a deferred field comes back next turn.

Every field that can be asked for is staged deliberately. A field with no stage
falls to the default, which is the last stage, which means it is asked only
once we already intend to buy.

**Enforcement:** Guard — `outreach/asks-must-be-staged`, six mutations. The
stage map is checked against the fields the module can actually ask for, so a
new askable field with no stage fails the build; the cap and the narrowing to
one stage are both anchored; the reply drafter and the stalled-conversation
chase must each select through `selectStagedAsks`; and the appended paragraph
must stay a backstop that fires only when the drafted body asks nothing.

## OUT-09 — Stalled conversations get chased

A conversation with no reply is followed up on a fixed cadence measured from
the last outbound message, not abandoned.

**Enforcement:** Audit — Agent 26 reports conversations past the gap with
nothing sent, and separately the ones exempt only because a draft has sat
staged on them for more than fourteen days. The exemption is the half worth
watching: a thread is not chased while an operator has something waiting on it,
and that is evaluated over the whole thread, so one draft nobody ever actioned
stops the sequence for good. On its first production run the audit found the
cadence itself healthy — nothing overdue with an empty outbox — and one thread
held by a draft staged more than fourteen days earlier. That is the shape to
watch, not the count: 3,461 drafts are sitting staged fleet-wide, so the number
of threads this can silence is bounded by how many of them go unactioned.
Capping the exemption is owed, and is a product decision rather than a check.

The audit runs on the sweep's own loader rather than a copy of its logic. An
audit that re-derives the clock drifts from the producer and then reports on a
pipeline that does not exist.

## OUT-10 — A cancelled outreach must release its alias

Cancelling in bulk without deleting the email alias leaves a ghost address that
still receives replies nobody reads.

**Enforcement:** Check owed — `outreach/cancel-must-release-alias`.

## OUT-11 — A rejected draft is not redrafted

When an operator discards a draft, in the Control Room or in the email app,
that decision stands. No sweep composes that same email again: same kind, same
address, same material.

What is rejected is the email, not the address. A supplier turned down for one
material is still worth asking about another, so a draft about a material the
discarded one did not cover is allowed. When neither draft names its materials
the whole kind stays blocked, because we cannot tell the two apart. Rejecting
the SUPPLIER is a different instruction and has its own list (OUT-13), which
the discard escalation writes to when ops answers "not a fit" (OUT-15).

Three more things are not a repeat of the rejected draft, and are still
allowed: a draft we discarded ourselves (retiring a bounced or replaced address
discards its drafts precisely so a new one can go out), a draft to a different
address, and a reply to a message the supplier has just sent us.

**Enforcement:** Guard — `src/lib/draft-suppression.ts` `isDraftSuppressed`,
called by `stageDraft` and by Agent 02, which stages its own draft directly.

## OUT-12 — "denied" in Tenkara does not mean "do not contact"

`suppliers.approval = 'denied'` is an ops validation state meaning the supplier
record is not validated yet, and the notes on it frequently ask for exactly the
opposite of silence: confirm EXW with them, check the supplier email for a
contact, ask whether they ship outside the EU. Do not build a do-not-contact
list out of it. A real do-not-contact list is the exclusion list on the lead.

**Enforcement:** Guard —
`suppliers/approval-denied-is-not-do-not-contact`. Recorded because a guard was
built on the wrong reading of this column on 2026-08-19 and removed the same
day. The check is on the meaning rather than on the old symbol names, which are
already deleted: the word `denied` may not reach a suppression verdict, and the
denied set may not be read out of the suppliers table. The two display sites
that legitimately bucket the column are allowed by name.

## OUT-13 — Do-not-contact has two authors, and one gate

A company can be off-limits because the client said so, in their own settings
in Tenkara, or because ops said so, in the ops list. Both are the same
instruction and are enforced in the same place, at draft time, so every path
obeys them: cold outreach, follow-ups, check-ins and replies alike.

Checking only at discovery is not enough. Discovery covers new leads, so a
company added to either list after outreach had started kept receiving
follow-ups. Adding a company to the ops list also discards any draft already
staged for it, because a block that leaves a sendable draft in the inbox is not
a block.

Scope is one client. The same company can be off-limits for one client and a
perfectly good supplier for another (see SUP-01).

**Enforcement:** Guard — `src/lib/do-not-contact.ts` `isDoNotContact`, called
by `stageDraft`; the client list also still filters candidates in Agents 03
and 04.

## OUT-15 — A discard has to say why, or it is a silent kill

An operator throwing a draft away stops us writing to that address for good
(OUT-11), and the email app tells us only that it happened, never why. The two
reasons need opposite handling: a rejected supplier should stay out, a wrong
contact should be re-hunted and kept.

Treated as one, it silently killed the supplier. The contact re-hunt only
picks up leads holding no address at all, so a supplier whose single address
was discarded could never re-enter it: measured 2026-08-19, 53 suppliers (42
California Chemicals, 11 SaponIQ) sat with a discarded draft and nothing live
or sent, and not one discard on record carried a reason.

So every operator discard raises an escalation on that client's Email Thread
Tracker asking why, and answering it acts. A working address requeues the lead
for outreach. No working address to hand, but the supplier is still wanted, is
the common case, so removing the address is its own answer: it retires that
address alone, keeps the lead active, and the contact hunt picks it up again.
Only "not a fit" ends the supplier, and that writes the do-not-contact list
(OUT-13) rather than relying on the discard. A bad mailbox must never cost a
supplier. Our own discards
(a retired address, a dropped lead) already know why they happened and never
ask. The question is asked once per supplier and address, not once per draft.

**Enforcement:** Guard — `src/lib/draft-suppression.ts`
`raiseDiscardReviewCase`, called from the Tenkara discard webhook, which is
the only place an operator discard is recorded.
