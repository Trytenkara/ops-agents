# Outstanding

Rules with no machine guard, and the breaks found while they had none. Audited
2026-08-19 against the working tree. Nothing here has been fixed yet.

An item leaves this list only when a check in `scripts/check-rules.mjs` (or an
audit job) makes the break impossible or visible.

---

## Verified NOT a defect

`vercel.json` registers a single daily cron, and the code comment claims a
five-minute interval. Production is not driven by that file: 8,315 agent runs
in the 24 hours to 2026-08-19 17:15Z, arriving every minute. The schedule is
configured outside the repo. The file is misleading and should be corrected,
but the fleet is running.

---

## P0 — Marketplace storefronts are silently dropped from outreach

Breaks OUT-02. A lead with no email that classifies as a marketplace is parked
and then excluded from the outreach query forever. No draft is ever made and no
aggregator channel exists in the outreach pipeline. The flag written to mark it
for later resolution (`needs_contact_resolution`) is written in five places and
read in none: the sweep its comment promises does not exist.

Two things make it worse. A lead can be retired as an aggregator index page
purely on a NAME heuristic whose generic word list includes "trade", "group",
"wholesale" and "suppliers", and that fires exactly when zero sellers were
readable, which is also what a slow or blocked page looks like. Separately a
site-type downgrade with no page read can convert the park into an outright
drop.

Real effect: on the order of a thousand storefront suppliers get a price row
and are never contacted, and the run summary logs it as intentional routing.

**Measured 2026-08-20.** 309 leads parked with `needs_contact_resolution` since
2026-08-08, zero ever attempted, 275 of them on paying clients (California
Chemicals 143, SaponIQ 132). 235 carried a `supplier_website`; 204 of those were
an aggregator host. That is the root cause and it is not the missing channel:
the storefront resolver, the module written to find a seller's own domain, was
gated on `!website`, so a listing URL in `supplier_website` read as "we already
have their site". The free crawl then ran against the platform and every address
it found was correctly stripped as a platform address (DATA-05). The re-queue
cycled them every seven days and they could not move.

**Fixed 2026-08-20.** The gate is now the absence of an *own* domain
(`website && !isAggregatorDomain(hostOf(website))`), so the resolver reaches the
population it was built for; and the index-page retirement no longer fires on an
`infra_failure`, which was latent — all 83 existing retirements name a real
page. Both are held by `outreach/no-terminal-drop-without-channel`.

Read back from production 40 minutes after the deploy: 15 storefront resolution
attempts, **9 of which the old gate would have skipped** because they carried an
alibaba / indiamart / knowde listing URL, and 5 own domains found. The 309
already parked drain more slowly — the re-queue only takes a lead whose last
enrichment attempt is over 168 hours old, so 35 were eligible that hour and the
rest become eligible by 2026-08-27.

**Still owed:** the aggregator inquiry channel wired into outreach, for the
storefronts whose own domain genuinely does not exist; a reader for
`needs_contact_resolution`; the name heuristic replaced by a page read.

## P0 — Direct suppliers with no email are dropped, defeating the retry queue

Breaks PERS-05. A re-queue path for parked contactless leads exists, is
scheduled, and is correctly written. It requires the lead to still be active.
The outreach agent sets exactly this case to dropped instead, so the lead is
permanently outside the only path that would try again. Nothing reads that drop
reason to revive it.

Also: leads untouched for 14 days are dropped (a case is opened, so it is a
handoff), and leads dropped as a duplicate open case get no case opened at all
— a silent exit with no artifact.

**Measured 2026-08-20.** 3,208 leads carry `drop_reason = 'no_contact_recovered'`.
2,325 of them belong to paying clients (California Chemicals 1,589, SaponIQ 733,
Vita Organica 3); the rest are Tenkara Internal. 3,195 would qualify for
`requeue_parked_contact_leads` this minute if they were still active. The only
reader of that drop reason anywhere in the repo is a UI label.

**Half fixed 2026-08-20.** The outreach agent now parks a contactless direct
supplier exactly the way it already parked a marketplace: active, at
`stage='enriched'`, stamped `outreach_parked_at`, flagged
`needs_contact_resolution`. Held by `outreach/contactless-must-park-not-drop`,
four mutations behind it. This is forward-only.

**Still owed:** the 3,208 already dropped are still outside the re-queue and
reviving them is a bulk write to production lead state, so it needs a decision
rather than a deploy. The 14-day untouched drop and the duplicate-open-case
drop are untouched. The scheduled skill sweep can be retired (META-03) only once
the backfill has run.

## "Verified" contact confidence — fixed forward 2026-08-20, rows still wrong

Breaks DATA-06. Confidence was set by `if (email)`, so every address the
waterfall resolved was labelled verified whatever found it. Measured on
2026-08-20: 8,093 leads said `verified` and 89 of them came from the one
provider that tests a mailbox. Three more writers existed outside the
enrichment agent — `contact-finder-agent/backfill.py` stamped verified on its
website scrape and its storefront-vision read, and
`importyeti-resolve-contacts/resolve.py` wrote the model's own `strong` /
`medium` / `lead` rating of whether it had found the right COMPANY into the
column that is read as a verdict on the ADDRESS.

**Fixed forward.** Three states now: `verified` only from a source in
`VERIFYING_SOURCES`, `discovered` for an address nobody tested, `guessed`
unchanged. A cache hit reads as discovered because it is a previous run's
answer. Held by `contacts/confidence-derived-from-source`, five mutations
behind it, and the check covers the skills corpus because that is where three
of the four writers were.

**Backfilled 2026-08-20**, same derivation as the code, from the source already
stored on each row: 8,608 to discovered, 94 pattern combos to guessed, 7 real
LeadMagic rows to verified, and 702 leads holding a confidence with no address
had the key removed. Old values snapshotted to
`/workspace/backfill-data06-snapshot.json` first. The column now holds three
words: 8,608 discovered, 821 guessed, 96 verified.

**Surfaced 2026-08-21.** The label was written on every lead and read by no code
and no screen. It is now the `unverified_contact` set in
`src/lib/flagged-work.ts`, counted on the client's own Overview tab, so a
guessed address is in front of somebody before the first email goes to it.

## P0 — Withheld prices were a complete dead end — FIXED 2026-08-21

Broke PERS-07 and UI-06. Five distinct withholding reasons were computed and
stored, and not one was read anywhere in the repository. The failure had five
separate legs and every one of them was load-bearing on its own:

1. The reason was written onto a result object that was already frozen for
   storage, so it died in memory. It now goes on the object that actually
   reaches the database, via one shared `withheldMark()` in
   `src/lib/price-publish.ts`.
2. The tier gate deleted the row carrying the reason, so the pack size that lost
   its price could not be named. `publishableTiers()` now hands the dropped
   rungs back and the mark reads "Pack sizes dropped: 5 gal".
3. The staged-quote collapse merged the extractor's raw note over the locally
   built one, dropping the explanation of why the row had no price.
4. Three interface surfaces gated on `needs_manual_pull`, a status retired by
   migration 0089 and emitted by nobody. All three now call one predicate,
   `pullNeedsOperator()` in `src/lib/marketplace-pull.ts`.
5. Nothing retried a withheld price. A gated row files as `pulled` with no
   `reason`, so Agent 19's worklist matched neither of its predicates. It now
   runs a second query for the withheld cohort and dedupes.

The registry `src/lib/flagged-work.ts` gives flagged sets their first surface —
withheld prices, priceless staged quotes and guessed contacts — rendered by
`FlaggedWorkPanel` on the client's own overview tab. The guard
`ui/flagged-set-must-have-a-surface` holds four things: the registry is
iterated rather than listed, the panel renders the registry rather than naming
sets it knows, the overview renders the panel, and an agent that calls the
publish gate must also record the mark.

**Still owed:** audit findings. UI-06 names them as a flagged set, but Agent 26
posts to Slack and nothing persists a finding, so there is no row for the
registry to count. Until they have a table they cannot have a surface.

## P1 — The prices already captured wrong — one row, corrected 2026-08-21

Broke DATA-14, DATA-15 and the basis half of DATA-01. Found 2026-08-19 by
re-reading all 77 California Chemicals supplier threads from Tenkara and
reconciling them against `staged_quotes`, because the table could not be
checked against itself.

**The forward half was fixed the same day.** DATA-14, DATA-15 and DATA-16 hold
guards and an audit: a price that does not reconcile arithmetically against the
supplier's own words is withheld rather than stored, `confidence` is derived
from `price-qa` instead of self-reported, and every inbound message records what
it stated against what was staged so a miss leaves a mark.

**Correction, 2026-08-20.** The first pass through these rows was itself wrong
and this section said so for a day. It read `price` as a per-unit figure when
`price` is the price of a CASE and `unit_price` is the derived per-unit column,
so four rows quoting `usd####/mt` against a 1000 kg case — Jiangsu Yny 2900,
Shandong Andy 1335, Henan Chemger 1280 — and Katonah's 620.5410 against a 518 lb
drum were reported as defects when all four are correct.

**The wrong row is corrected and the residue is sized, 2026-08-21.** The audit
concluded a stored row could not be rechecked because it does not carry the
supplier's words. That was half true: it does not carry the message, but every
row carries `raw_extract`, the extractor's own reading of it, including the unit
the price was stated in. `reconcileQuoteRow` compares the stored columns against
that reading — no message, no model call, no network. Run over all 106 priced
rows fleet-wide it returned exactly one failure, the Yujiang row the hand audit
had found: `USD1015/MT` with `180KGS/Drum` stored as 1015 for the drum, reading
$5.64/kg for a material quoted at $1.015/kg. Corrected in place to 182.70 for
the 180 kg case, the old figures written into `extraction_notes`, left
`pending_review` for an operator to confirm. The fleet re-reconciles clean.

So this client was not unusual; it was the only one. The two Hangzhou Ontology
MCT rows that also differ from their extract had already been hand-corrected and
say so on the row.

The reconciliation is not a one-off script. It is the `unreconciled_quote` set
in `src/lib/flagged-work.ts`, recomputed on every load of the client's Overview
tab, so the next row that stops reconciling is counted on the client's own page
rather than waiting for someone to re-read a mailbox.
`scripts/repair-unreconciled-quotes.mts` corrects the one class arithmetic can
settle and reports the rest.

**Still owed:** the six price points that produced no row at all — Shandong Depu
(usd1300/mt), Sinochem Nanjing (USD1450/MT), Hefei TNJ (usd1490/mt), Foodchem's
revision (1.53 FOB / 1.81 CIF, leaving the superseded 1.49 live) and Reroot's
second material. Those are not an extractor fault: `inbound_message_ledger`
marks those suppliers `recorded_unmatched`, so the replies never reached
extraction. They arrive through the normal path only when the unmatched
conversations are replayed, which is the item below. Five of the six were
recovered by that replay; only Sinochem Nanjing is still missing, and it is one
of the threads that names no supplier at all.

## P1 — Dead-lettered supplier replies — replayed 2026-08-21, two causes left

ORG-11's fix stopped new replies being parked, but a parked reply is never
reconsidered: the reconcile sweep skips any message already in
`inbound_message_ledger`. `scripts/replay-unmatched-inbound.mts` clears the
ledger row so the message reads as unseen and then runs the SAME reconcile pass
the scheduled sweep runs, so a replay cannot drift from normal processing.
Candidates come from `unmatched_inbound_events`, the durable record that a reply
was parked, never from the ledger outcome, which changes the moment a replay is
attempted and would hide any message a failed attempt had touched.

**Replayed:** 36 messages across the resolvable conversations, 7 drafts
produced, 0 failures, 28 triage cases closed and 25 clarification drafts
retired. A message the ledger records as `drafted` or `deduped` is never
replayed — clearing its ledger row would stage the same quotes twice — so the
already-answered conversations had only their triage artefacts retired.

**A second cause was found while replaying: 27 of the parked events named no
client at all**, so they were not even candidates. Not one of them was a doubt
about whose reply it was. The router asked which client owns the mailbox, and
that question is unanswerable for a webhook carrying no account id, and for an
account id two orgs share. 25 of the 27 were named unambiguously by their own
draft references. That is ORG-12, now the third signal in `resolveInboundOrg`
and guarded by `orgs/inbound-org-must-try-the-thread`; the same test backfilled
the 25 in place, which exposed a further 13 conversations to the replay.

**Still owed, two populations:**

1. **19 conversations no draft on the thread names a supplier for.** Not a
   replay fault — the supplier link was never written (ORG-10). They need the
   link backfilled upstream, and Sinochem Nanjing's missing price is one of
   them.
2. **2 conversations genuinely unowned** — their mailbox is mapped to nobody
   and their thread names nobody. Correctly left alone: ORG-12 stops at one
   owner or none, because picking between two would be the guess ORG-04
   forbids.

## P1 — Two draft paths bypass the staging chokepoint

Breaks COMM-08 and META-03. Two paths create a draft on the platform without
going through `stageDraft`, so neither `sanitizeDraft` at runtime nor
`copy/scope-must-cover-every-draft-site` at build time can see them. They are
safe today only because their own drafters happen to sanitise; the next caller
that skips it is unguarded.

**Owed:** `copy/no-direct-draft-create`, or better, route both through
`stageDraft` and delete the second path rather than guarding it.

*Resolved 2026-08-20 (the rest of this item):* the check itself flagged zero of
1,083 candidate lines because its pattern required the offending line to BEGIN
with one of five identifiers. Rescoped per the `CONFLICTS.md` K ruling to a
named list of outbound-copy files including the model prompts, which surfaced
28 live breaches: a subject-line template built with an em dash, "Write the RFQ
email" 44 lines after the prompt banned the word, sixteen em dashes inside the
system prompt that writes supplier replies, and "Weeks of manual RFQ work" in
the expedited report, which is a client deliverable that never passes through
staging at all. All 28 fixed; the guard now has five mutations behind it per
META-09.

## Closed 2026-08-21 — zero results were accepted as an answer in nine places

Broke PERS-03. All nine now go through `src/lib/dry-pass.ts`, which names the
three outcomes a pass can have — found, dry, infra — and holds every cross-run
dry-pass bound in one readable place per PERS-04. The shape is lifted from the
one source that already had it right, Agent 01's SourceReady counter, which was
moved onto the helper rather than left as a private copy: a private copy is how
the other eight drifted.

What each site was doing:

1. **The price pull retired an umbrella lead on one clean zero.** The
   `infra_failure` clause had already been added on 2026-08-20, so this was
   half fixed, but `infra_failure` only knows about a call that *broke*. A call
   that succeeds and returns valid JSON naming no sellers — a JS-rendered
   listing, a bot wall serving a stub, a read that stopped short — carried no
   flag and was terminal forever. It now banks a dry pass and hands the row to
   the ordinary needs_review backoff, retiring only at three.
2. **An empty alias list was cached with no expiry** and short-circuited every
   future run, blinding all three discovery sources for that material — exactly
   the Rapeseed Fatty Acid failure the resolver was written to prevent. An
   empty answer now banks a dry pass; only three of them settle it. A missing
   `ANTHROPIC_API_KEY` used to return `[]` with no log at all, which is what a
   rotated key looks like from the outside; it warns now.
3. **The ImportYeti client read a 200 with no `data` array as an empty
   market.** An error envelope, a renamed field or a truncated body all logged
   a cheerful "staged 0 of 0" and burned a dry page. `rowsOrThrow` demands the
   field and throws, which is what the caller's existing catch already knows
   how to handle — it leaves the page cursor unadvanced. SourceReady got this
   guard after its 2026-08-08 outage; this one never did.
4. **A crashed marketplace re-check was laundered into a `needs_review`
   finding.** That is worse than losing the read: a `pending_review` row locks
   the quote out of every future run, so one model-call failure on an expiring
   quote meant it was never re-checked until an operator dismissed a finding
   whose only content was the error message. It now writes nothing and leaves
   the quote in the queue. The same failure arriving by return value
   (`infra_failure`, the model answered with something that was not JSON) is
   skipped the same way.
5. **A supplier site that loaded but printed nothing froze all twelve fields**
   as `not_published` on the first pass and dropped the profile out of every
   future run — and `supplier-profile-fill` then reads that stamp as proof the
   site was exhausted and promotes the profile to `pending_review`. The
   unreachable branch three lines away already counted attempts correctly; this
   one now shares that counter.
6. **A 403 or 429 rested a document page for sixty days** as if it had been
   read, and bot-blocking is this agent's measured ceiling: 10 of 80 pages on
   the first live run. Migration 0128 adds `blocked_passes` and `retry_after`,
   and a blocked page comes back on a 1/3/7-day ladder instead.

**Enforcement:** `discovery/zero-must-not-be-terminal`, nine mutations. PERS-03
moves from Check owed to Guard.

## Closed 2026-08-21 — deliberate caps hid work in thirty-odd places

Broke PERS-06. The accidental thousand-row cut was already closed by the
truncation guard, but that guard waves through any request carrying an explicit
`.limit()`, on the reasoning that a limit somebody typed is a limit somebody
meant. Every remaining break was therefore an explicit limit — and the ones
that mattered were not too small, they were unannounced. "Found 25 stale leads"
and "QA'd 100 drafts" both read as the whole backlog. A page showing 50 of
3,461 staged drafts looked exactly like a page showing 50 staged drafts.

The class fix is that a capped read carries its own remainder. PostgREST
returns the true matching count on the *same* request as a capped page, so
`.select(cols, { count: "exact" })` costs nothing and removes the excuse.
`src/lib/capped-read.ts` wraps that for runtime code and hands back
`{ rows, total, remainder, note }`, the note already worded for a log line or a
run summary. `src/components/showing-note.tsx` is the same thing on a page.

Three sites were not capped-and-reported but re-read in full with
`selectAllPaged`, because there the window changed the *answer* rather than the
volume:

- The sibling-lead lookup in the no-reply follow-up read the first fifty leads
  for a supplier, so a contact outside that window was a person we then never
  CC'd — which reads downstream as "this supplier has one contact".
- The inbound router resolved a thread's owner from 200 draft references. A
  second client whose reference fell outside the window turns an ambiguous
  thread into a confidently wrong owner, which is the ORG-06 fault.
- The permanent-bounce retire capped at 500. A dead mailbox is dead on every
  lead carrying it, not on the first five hundred.

One site was rewritten rather than reported: the outreach-retry action decided
whether a supplier already had a live thread by pulling a slice of the client's
drafts and scanning it in JS. A window there is not a cost control, it is a
wrong answer — the row past the cap is the live thread we then write over the
top of. It now asks the database the actual question, twice, by supplier and by
contact address, with `.limit(1)`.

Everything else — the agents, the API routes, the runbook answers, nine
Control Room pages — kept its cap and gained the count. The API feeds also
gained a `remainder` field; the resolutions feed additionally caps its `until`
cursor to the oldest unread row, because a since-cursor handed a short page
with no remainder walks forward past everything it never saw.

**Enforcement:** `reads/limit-must-report-remainder`, three mutations. It reads
`.limit()` on a work table — resolving the table through a chained `.from()` or
through a builder held in a variable — and demands an exact count, a
`cappedRead`, a `selectAllPaged` or a `ShowingNote` within sight of it. Two
windows are waived in `DECLARED_WINDOWS`, keyed by path *and* by the limit
expression: rename the constant and the waiver stops applying. PERS-06 moves
from Check owed to Guard.

## Closed 2026-08-21 — call tasks reached nobody

Broke AUTO-08. Measured first: California Chemicals' 132 open call tasks are all
owned by genuine call operators, and the unowned ones at the other two clients
are unowned by design. So the write paths were already right, and the rule was
being broken in the three places nothing revisits.

The notification. The agent path raises essentially every call task, and it
posts into the daily digest, which renders the title and nothing else. Both
names were in the body. The email operator therefore never learned their
supplier was being called, which is the visibility half of the rule and the half
that never reached anyone. The title now carries both.

The stale stamp. When derivation declined to own a call, `deriveCaseOwners` fell
back to whatever was stored — correct for desk work, wrong for a call, because
the stamped operator may have moved to the email desk. It now clears the stamp
in that case: an unowned call says the client needs a caller named, a wrongly
owned one is a task somebody believes is handled.

The removal path. `reassignIneligibleOwners` moved claims, drafts and leads and
never touched `cases`, so a removed operator stayed the named owner of every
open escalation they held. Cases are now reassigned too, with calls routed over
the call pool and set unowned when no caller remains.

**Enforcement:** `assignment/call-owner-must-be-call-operator`, six mutations,
one per limb. AUTO-08 moves from Check owed to Guard.

## P1 — The dealbreaker-grade guard arms intermittently, and has never fired

Breaks DATA-08. Found 2026-08-20 while ruling `CONFLICTS.md` L. Two separate
faults in the one guard.

**It arms on an unstable value.** `grade_ask_widened` only runs when
`metadata.required_grade` is set, which is resolved from Tenkara at draft time.
For California Chemicals' Propylene Glycol, whose Tenkara record has not
changed since 2026-08-07, Agent 04 armed 7 drafts and left 203 unarmed over the
following thirteen days, with armed and unarmed drafts on the same day. Same
material id, same code path, no branch in our code that could explain it, so
the flag is moving on the Tenkara side without touching `updated_at`, or the
read is not returning a stable row. Until that is understood, a client who does
set a dealbreaker grade is protected on an unpredictable fraction of drafts.

**It has never fired.** Zero blocks across the 1,129 armed drafts. The pattern
does match the phrasing from the incident the rule was written for, so unlike
COMM-08 it is not inert, but it is five narrow alternations and misses softer
invitations that break the rule identically: "coconut-based as well if palm
isn't available", "we'd also welcome your coconut option", "let us know what
else you stock in this range". A model writing the copy is not obliged to use
the phrasings we thought of.

**Owed:** first, find out why the arming value moves, since a fix to the
pattern is worthless while the trigger is a coin toss. Then widen the pattern,
or better, stop pattern-matching outbound copy for this and check the ask
against the stated grade directly, per the standing preference for reading over
another regex. The check needs a mutation behind it per META-09, which today it
does not have.

## P2 — Guessed contacts can be synthesised at a directory

Breaks DATA-05. The guess builder is otherwise correct: right combinations,
right source suffix, right confidence, and the body fabrication guard does not
interfere. But the aggregator check uses a hand-copied private list that has
drifted from the shared one and does not include the directory host list at
all, so several well-known directories will get five synthesised addresses.

**Owed:** delete the private list, import the shared one (META-04).

## P2 — Nothing stops a paced loop from outrunning its function

Breaks PERS-09. The thread owner sync now carries a `deadlineAt` through both
of its push loops, but nothing prevents the next per-item loop over a rate
limited API from being written without one, and that failure is invisible by
construction: the run is killed, so it reports no counts and no cursor. Other
loops that push or fetch one item at a time (the outreach sender, the price
pull, the Tier B escalation) each have their own ad hoc bound or none.

**Owed:** `check-rules` id `runs/paced-loop-must-carry-deadline`, plus one
shared deadline helper the loops take instead of each inventing a bound.

## P2 — Two hand-rolled retry classifiers remain

Breaks PERS-01 and META-04. The shared classifier is referenced in three places
repo-wide; one true duplicate remains in the browser-based pull. A persistent
rate limit or anti-bot block there is laundered into an operator-facing "login
wall" verdict, which is wrong and sends a human to look at a page that is not
gated. One 404 is folded in with genuinely terminal codes in the owner sync.
The shared classifier itself returns a terminal verdict on attempt exhaustion
despite its own comment saying exhaustion is per-run.

**Owed:** `check-rules` id `retry/no-inline-classifier`.

## P2 — Cross-client name lookups

Breaks ORG-06. A name search over the shared supplier table mislabelled 907
conversations. The scoping rule exists; the repair of the affected records and
the identifier backfill are still outstanding.

## P2 — No pre-merge build gate

Breaks SHIP-06. A workflow file exists on disk and has never been committed:
the token used to push is not permitted to create one. Until that permission is
widened, the pre-push hook is the only gate, it only exists on a checkout that
ran an install, and it is bypassed by a single flag.

**Owed:** widen the token's scope, then commit the workflow.

## P2 — Nothing prevents staging everything

Breaks SHIP-02. A blanket stage once swept another agent's in-progress work
into an unrelated commit.

**Owed:** a pre-commit hook that refuses a commit containing paths outside
those explicitly staged for the current task, or at minimum refuses untracked
scratch files at the repository root.

## P2 — Shipping extraction success rate is not monitored

Breaks PRICING-04. Agent 19 logs `shippingAttempted` and `shippingCaptured` per
run, but nothing queries these metrics to alert if extraction rate falls below
50% (or a configured threshold). A feature that is not monitored is a feature
that silently stops working.

**Owed:** daily health job querying leads where `marketplace_pull.shipping_cost
!= null` divided by leads where org has `ship_to_address AND
marketplace_pull.status='pulled'`, alert if ratio drops below threshold;
`check-rules` id `shipping/health-must-monitor-extraction-rate`.

## P2 — A discard on a revalidation draft can be answered but not acted on

Partial break of OUT-15. The escalation is raised for every operator discard,
but the two actions that keep a supplier alive (enter a working address, or
remove the bad one) both write a lead, and a revalidation draft is composed off
a quote with no lead row behind it. Measured 2026-08-19: of 44 open discard
escalations, 23 are actionable and 21 are not, so those 21 can only be closed
with a note. Closing with a note leaves the address suppressed, which is the
silent kill OUT-15 exists to prevent.

The remove-address action also depends on the enriched-no-email sweep, which is
itself a workaround recorded under PERS-05 (conflict E). If that sweep stops,
this action retires the address and nothing goes looking for a new one.

**Owed:** a lead for the supplier behind a revalidation draft, or a second
resolver that retires the address on the supplier profile when no lead exists;
`outreach/discard-escalation-must-be-actionable`.

## P2 — The Tier B scrape can overwrite an operator's price ladder

Breaks DATA-13 and DATA-17. `lead-price-pull.ts` refuses to rewrite tiers a
person entered (`operatorEdited = !!payload.price_tiers_updated_by`). Agent 19,
the Browserbase escalation that reads the pages Agent 05 cannot, writes
`price_tiers` and `marketplace_pull` on any successful scrape with no such
check, so the scrape would replace the operator's ladder.

Measured 2026-08-20 across the non-internal clients: 0 leads carry
`price_tiers_updated_by`, so nothing has been overwritten yet. It is a hole, not
an incident. Left unfixed only because that file held another session's
uncommitted work at the time.

**Owed:** the `operatorEdited` guard in
`src/agents-runtime/agents/browserbase-escalation/index.ts`, and a check that
holds every price-tier writer to it: `price/tiers-must-respect-operator-edit`.

## Closed 2026-08-20 — the quotes table now carries a lane

Was: `quote_profiles` keyed a supplier's prices on supplier plus material with
no lane, while PRICING-07 deliberately gives the direct version of a marketplace
supplier the same name and id, so either writer could adopt the other's row.

Fixed by migration `0126_quote_profiles_lane.sql`: `lane` is not null, both
seeders read and write only their own lane, `insertQuoteProfile` refuses a row
that does not name one, the filler's unconditional USD write is gone (DATA-11),
and the quotes tab shows the two versions as two cards. Backfill on production
2026-08-20: 7,952 marketplace, 106 direct, 0 unknown. No contaminated row was
ever found; this was an open door, closed before a fire.

## Closed 2026-08-20 — a guard only bound the repository, and the skills were not in it

Breaks COMM-06, and the same shape as Conflict K. `comm/one-slack-channel` is
classified `Guard` and works: it fails the build on a channel passed to
`postSlackMessage`, and it names six retired channel env vars explicitly. But
its corpus is this repository, and the agent skills live in
`/workspace/.claude/skills/`, on an unversioned container volume the build never
walks. So a rule the ledger reports as enforced was, for the skills, not
enforced at all — and "Guard" reads as covered.

Four skills post to Slack. All four were breaking it on 2026-08-20, one day
after COMM-06 retired the other channels:

- `california-chemicals-watchdog` hardcoded `C0BATUWBHC7` (#control-room-feedback)
- `sourcing-health-watchdog` took a `--slack-channel` argument, which is the
  invariant itself inverted: a caller may ask for a post, never for a destination
- `materials-expiry-slack` read `EXPIRY_CHANNEL_ID`, default `C0BCZ5CPAKU` (#ops-sam)
- `aggregator-inquiry/prepare.mjs` read `SLACK_ESCALATION_CHANNEL_ID`

The last two read env vars named in the guard's own retired list, so no
judgement was needed: the rule had already ruled on them. All four now resolve
`SLACK_OPS_CHANNEL_ID` defaulting to `C0B5M1QCE9E`, the same default as
`postSlackMessage`, and `--slack-channel` became a destination-free `--slack`.
`report-issue-triage/SKILL.md` also told the agent to watch and reply in the
retired channel and now cites rule ids instead.

**The class is now closed.** `check-rules.mjs --also DIR` takes a second corpus,
and the skills repository runs it on every commit from `.githooks/pre-commit`.
It cannot be a build step: the Vercel deploy host has no skills directory, so a
check there would find nothing and report success, which is this bug again. The
corpus is Python, plain JS and markdown as well as TypeScript — a `SKILL.md` is
where an agent is told which channel to watch, so instructions are a call site.

Two things had to change for the checks to survive contact with it. The comment
stripper only understood JavaScript, so a Python docstring saying "downstream
`convertToUsd` handles conversion" read as a call to it. And
`comm/one-slack-channel` only recognised the shapes code uses (`channel:`,
named env vars), so a bare id in prose — the very way `report-issue-triage`
pointed at the retired channel — went straight past it; it now rejects any
Slack id that is not `C0B5M1QCE9E`. Proven by breaking it: a retired id added
to a skill fails the commit.

**Still owed.** Four pre-existing sites are grandfathered by name in
`rule-checks.mjs`, not waived — three skills hand-roll a mailbox-domain list
(`contacts/no-inline-mailbox-list`) and one hand-rolls org priority
(`queues/no-inline-org-priority`). They break META-04 for real: the canonical
lists are TypeScript modules a Python skill cannot import, so the fix is a
shared data file both languages read, and doing that behind a build gate would
have meant editing four running skills to turn the gate on. It is a ratchet, so
every new break fails; nothing may be added to that list. The same cross-
language duplication is why four skills each hardcode `C0B5M1QCE9E` rather than
resolving it from one place.

Two follow-ons closed with it on the same day.

`ENFORCEMENT.md` now says which places a Guard binds, in a paragraph the
generator writes above the tables, so "Guard" can no longer be read as "guarded
everywhere". Naming the place per rule is still index work; the header removes
the wrong default reading, which is what actually misled.

And the hook that runs the skills check was itself switched on by local machine
config that no tracked file carried. `scripts/install-hooks.mjs` now installs
both repositories' hooks from `npm install`, and `check-rules` refuses to pass
locally while either repository has its hooks unset, so an off switch is loud
instead of silent. Proven by unsetting it: the build failed and named the
repository. Residual, small and deliberate: a checkout of the skills repository
on its own, with no `npm install` of this one, still gets no hooks. The stronger
version is a server-side check on push, which nothing local can turn off.

## The full enforcement debt

Sorted 2026-08-19. Every rule whose Enforcement line says "owed" appears here;
the build refuses otherwise. The sections above describe the breaks already
found and are the priority. This is the complete list, including the rules
where nothing is known to be broken yet and only the guard is missing.

A rule leaves this list by having its check or its job built, or by being
reclassified as `Judgement` because nothing mechanical can ever verify it.

### Check owed — a build check is possible and is not built

<!-- generated-membership: the ids in this table and the next must be exactly
     the rules whose Enforcement line admits a debt. `rules/debt-register-must-
     match-the-ledger` fails the build otherwise, in both directions. -->

| Rule | The check |
| --- | --- |
| META-04 | `meta/no-second-copy-of-a-shared-guard`, beyond the invariants already covered |
| COMM-08 | the scope's edges. `copy/no-rfq-or-em-dash-in-templates` holds a named list of outbound-copy files and `copy/scope-must-cover-every-draft-site` makes a `stageDraft` caller missing from it a violation. Copy reaching a supplier by some other path is still unseen. |
| DATA-05 | the shared host list. `contacts/guessed-combo-requires-own-domain-and-flag` shipped 2026-08-20 and holds the gate and the flag together. The gate still reads a hand-copied list in `enrich.ts` that has drifted 15 hosts behind `src/lib/aggregator-hosts.ts`, so a guess is allowed on those hosts. Merging the lists is a behaviour change for every other caller of the shared one, which is why it is not folded in here. |
| PERS-01 | `retry/verdict-must-use-shared-classifier`. Three call sites use `classifyFailure` and two hand-rolled classifiers remain — see the P2 above. |
| PERS-02 | `queues/flag-must-not-exit-queue` |
| PERS-04 | the run-summary half. `retry/bound-must-be-declared` shipped 2026-08-20 and holds the rules-folder half: all seven bounds are now named under PERS-04 and an eighth fails the build. A bound must also appear in the run summary, which cannot be read from the source. |
| PERS-09 | `runs/paced-loop-must-carry-deadline`. `deadlineAt` holds the one job it was written for; a new per-item push loop with no deadline passes the build today. |
| DISC-05 | `discovery/platform-is-never-manufacturer` |
| DISC-09 | `discovery/self-supplied-gate-must-fail-closed` — gates are fail-open today |
| OUT-02 | the aggregator inquiry channel itself. `outreach/no-terminal-drop-without-channel` stops a storefront being dropped for having no email; it cannot make the inquiry form a channel we can actually send through. |
| OUT-08 | `outreach/asks-must-be-staged` |
| OUT-10 | `outreach/cancel-must-release-alias` |
| ORG-06 | `orgs/name-lookup-must-scope-query` — see the P2 above |
| UI-02 | the seven existing global review routes. `ui/no-global-review-route` shipped 2026-08-20 as a ratchet, so no eighth can be added, but the seven that predate it are still live and still cross-client. Removing them is a product decision. |
| UI-06 | somewhere to persist an audit finding. `ui/flagged-set-must-have-a-surface` makes every set in the registry render; findings that live nowhere never reach the registry, so the guard cannot see them. |
| SHIP-02 | pre-commit hook refusing unstaged paths — see the P2 above |
| SHIP-07 | column granularity. `ship/migration-must-accompany-schema-read` shipped 2026-08-20 over tables and RPCs; all 49 tables and 15 functions read today are created by a migration, so it is a ratchet. A read of a *column* that no migration adds is still invisible, and that is the shape ENG-1036 took. |
| PRICING-01 | `shipping/cost-must-be-numeric` |
| PRICING-02 | `shipping/cost-per-tier` |
| PRICING-03 | `shipping/extraction-org-opt-in` |
| PRICING-05 | `shipping/no-fabricated-costs` — the per-tier estimator breaks it today, see the P2 above |

### Reported by an audit, and the audit closes nothing

Agent 26 reports DATA-08, PRICING-04, PERS-07, DISC-08 and OUT-09 every morning
and repairs nothing. Each needs a person to decide what the right value was, so
an audit that wrote its own answer would be guessing. What is left owing, and
what each one found on its first pass:

| Rule | Still owed |
| --- | --- |
| PERS-07 | the surface. All 19 withheld prices carry no reason at all, and until UI-06 ships there is nowhere on the client's tab for them to appear, so somebody has to read the audit to find them. |
| PRICING-04 | the fix. Zero attempts against 4,044 pulled listings, because `getOrgShipToAddress` selects `ship_to_*` columns that do not exist on this project's `orgs` table and the catch swallows it. The audit now says so out loud; it does not move the columns. |
| DISC-08 | the 52 orphaned cursors and the 15 markers written without `done`, all of which currently read as finished and gate their material off SourceReady permanently. Deleting them is a one-off repair nobody has run. |
| OUT-09 | the exemption itself. A staged draft suppresses the chase for as long as it sits there, with no cap; the first audit run found one thread in that state and 3,461 staged drafts fleet-wide that could put others there. Capping it is a product decision. |
| DATA-08 | the 7 materials where arming disagrees with Tenkara, and the widening phrasings the blocking code still misses. |

## Open decisions

None open.

`CONFLICTS.md` K (scope of the em dash ban), L (the dealbreaker grade rule) and
M (whether COMM-05 admits an explicit "post this as me") were all ruled on
2026-08-20. M was ruled no: COMM-05 is absolute.
