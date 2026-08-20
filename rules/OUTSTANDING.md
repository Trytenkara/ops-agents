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

**Owed:** stop dropping; park as active so the re-queue can see it. Then the
scheduled skill sweep can be retired (META-03).

## P0 — "Verified" contact confidence is stamped on unverified addresses

Breaks DATA-06. Any email at all, from any source including a free crawl and a
30-day shared domain cache, is labelled verified. The one provider verdict that
does mean something is used inline and never stored. An operator-typed address
keeps whatever label was there before.

Real effect: the guessed-versus-verified label operators rely on at draft
review is meaningless for most leads.

**Owed:** confidence derived from the source, not from the presence of a
string; the same-run verification verdict persisted.

## P0 — Withheld prices are a complete dead end

Breaks PERS-07 and UI-06. Five distinct withholding reasons are computed and
stored. Not one is read anywhere in the repository. The tier-level gate deletes
the row carrying the reason, so usually it does not even survive. A "withheld"
note is appended to a result object after that object was already frozen for
storage. Three interface surfaces that would show it gate on a status that was
retired by a migration and is emitted by nobody. Nothing retries a withheld
price: the escalation agent's selection excludes them structurally.

**Owed:** surface the flagged set on the client's own tab; include withheld
prices in the escalation agent's selection.

## P1 — The prices already captured wrong are still live

Breaks DATA-14, DATA-15 and the basis half of DATA-01. Found 2026-08-19 by
re-reading all 77 California Chemicals supplier threads from Tenkara and
reconciling them against `staged_quotes`, because the table could not be
checked against itself.

**The forward half is fixed, same day.** DATA-14, DATA-15 and DATA-16 now hold
guards and an audit: a price that does not reconcile arithmetically against the
supplier's own words is withheld rather than stored, `confidence` is derived
from `price-qa` instead of self-reported, and every inbound message records what
it stated against what was staged so a miss leaves a mark. What follows is the
residue that fix does not touch, because it is forward-only.

**Correction, 2026-08-20.** The first pass through these rows was itself wrong
and this section said so for a day. It read `price` as a per-unit figure when
`price` is the price of a CASE and `unit_price` is the derived per-unit column,
so four rows quoting `usd####/mt` against a 1000 kg case — Jiangsu Yny 2900,
Shandong Andy 1335, Henan Chemger 1280 — and Katonah's 620.5410 against a 518 lb
drum were reported as defects when all four are correct. Katonah is off by
0.04%, the supplier's own rounding. Re-verified against the source emails.

Against 54 price points the suppliers actually sent, the table holds 48 distinct
rows (plus one duplicate). **One is wrong:** Yujiang, row
`5bee93d0-0876-4a22-ab21-4b5e447dd118`. The email says "EXW price: USD1015/MT;
Packing: 180KGS/Drum"; the row stores 1015 against a 180 kg case, so the
material reads $5.64/kg instead of $1.015/kg. The basis was read off the packing
line. Stamped `confidence: medium`, `status: pending_review`.

Six price points produced no row at all, and no record that anything was read:
Shandong Depu (usd1300/mt), Sinochem Nanjing (USD1450/MT) and Hefei TNJ
(USD1490/mt) were missed entirely; Foodchem's revision (1.53 FOB / 1.81 CIF)
was dropped, leaving the superseded 1.49 as the client's live figure; Reroot's
second material was dropped.

The misses are not an extractor fault. `inbound_message_ledger` marks those
suppliers `recorded_unmatched`: the replies never reached extraction at all.
`unmatched_inbound_events` holds 85 unmatched inbound replies in the 30 days to
2026-08-20 — 46 with a client resolved, across 43 distinct conversations, and 39
that arrived at an inbox mapped to no client.

**The 46 are diagnosed and fixed forward.** Every one failed the same test: the
router keyed candidate agreement on `supplier_id ?? ""`, so a thread whose cold
outreach predated the supplier link held both `null:material` and
`supplier:material` and was refused as ambiguous. That is ORG-11, now a rule
with a guard. Replayed against the live table the new test resolves 37 of the
43. The remaining six name no supplier on any draft — Sinochem Nanjing is one,
which is why its price is on the missing list — so there is nothing for the
router to agree about. Those need the supplier link backfilled upstream, not a
looser router.

The 39 with no client are a different fault and still live: the receiving inbox
is not mapped to a Control Room client, so there is nothing to file them
against. That path already alerts p2 per inbox.

The wrong row is still in the table as found. The new gate runs at capture time,
so it cannot reach a row captured before it existed: nothing re-reads history,
and no stored row carries the source fragment the guard needs, so a bad row
cannot be identified in bulk by the same test that would now stop it. Scope
beyond this one client is unmeasured — the same read has not been run for the
rest of the fleet, and the per-message ledger only starts counting from messages
that arrive after 2026-08-19.

**Owed:** a replay of the 43 unmatched conversations, since ORG-11 only changes
what happens to the NEXT message on them and nothing re-reads the ones already
in the dead-letter table — that is how the six missed price points arrive
through the normal path; mapping the inboxes behind the other 39; a re-extract
path, since none exists and the capture-time fix leaves every existing row
exactly as it is; correcting the Yujiang row; and the same reconciliation run
fleet-wide to size the residue, which is the only way to learn whether this
client was unusual or typical.

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

## P1 — Zero results are accepted as an answer in nine places

Breaks PERS-03. The worst: a price pull writes a permanent terminal state on
zero readable sellers without checking the infrastructure-failure flag that the
same file honours elsewhere, so one flaky model call kills an umbrella lead and
its sellers for good.

An empty alias list is cached with no expiry and accepted as a valid answer
forever, which permanently blinds all three discovery sources for that
material. That is precisely the failure the alias resolver was built to fix.

The import-data client only throws on a server error, so a changed schema or an
error envelope returns zero suppliers and logs a healthy pass. The equivalent
guard was added to the other source after an outage; this one never got it.

Also: a crash fallback parks an expiring quote until a human dismisses it; a
site that loads but yields no fields is excluded permanently while a site that
fails to load correctly gets three attempts; a rate-limited document page is
excluded for 60 days.

**Owed:** one shared dry-pass helper that distinguishes a real zero from a
failure, applied at all nine sites; `check-rules` id
`discovery/zero-must-not-be-terminal`.

## P1 — Deliberate caps hide work in eighteen places

Breaks PERS-06. The accidental thousand-row cut is genuinely closed: the
truncation guard is in both database clients and no unguarded bare read
remains. But the guard treats any request carrying an explicit limit as
intentional, so every remaining break is an explicit limit.

Highest impact: the read feeding the cross-client leak alert is capped at 50,
so the alert under-reports the blast radius of an isolation breach. A document
requirement check capped at 5,000 makes us re-ask suppliers for documents we
already hold. Two reads sit exactly at the thousand-row page size and are
therefore doubly truncated. Two cadence sweeps cap at 300 with no ordering at
all, so past 300 an arbitrary and unstable subset of suppliers silently stops
getting call and no-reply follow-ups. An inbound reply is matched against only
the twenty newest staged quotes, which creates duplicates.

Four more drain over successive runs but never say how many are waiting, and
one logs a count that reads as "all of them".

**Owed:** an exact count on the same request plus "N more waiting" in every
summary; `check-rules` id `reads/limit-must-report-remainder`.

## P1 — Call tasks reach nobody

Breaks AUTO-08. The assignment library is correct. But the agent-scheduled path
that raises essentially all call tasks posts at a severity that never appears
live, with nobody mentioned, and a title that names only the caller. So the
email operator's name never reaches Slack and no one is notified. Only the
manual button satisfies the rule.

Separately, when derivation declines to own a call the code keeps whatever is
stamped in the database, so an operator moved to the email desk keeps showing
as the owner of open calls indefinitely. A sibling surface handles this
correctly.

**Owed:** case rows included in owner reassignment. The notification half is
closed differently than written: as of 2026-08-19 nothing an agent raises posts
live, so the agent call path queueing into the digest is now the intended
behaviour, and the digest line names the caller. The email operator's name is
still only in the body, which the digest does not render.

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

| Rule | The check |
| --- | --- |
| META-04 | `meta/no-second-copy-of-a-shared-guard`, beyond the invariants already covered |
| COMM-05 | `comm/one-slack-sender` — one send helper, bot token only, no user token anywhere |
| COMM-09 | `crawl/no-agent-identifying-user-agent` |
| AUTO-06 | `outreach/no-send-outside-operator-action` |
| AUTO-08 | `assignment/call-owner-must-be-call-operator` |
| DATA-05 | `contacts/guessed-combo-requires-own-domain-and-flag` |
| DATA-06 | `contacts/confidence-derived-from-source` — see the P0 above |
| PERS-02 | `queues/flag-must-not-exit-queue` |
| PERS-03 | `discovery/zero-must-not-be-terminal` — see the P1 above |
| PERS-04 | `retry/bound-must-be-declared` |
| PERS-05 | `outreach/contactless-must-park-not-drop` — see the P0 above |
| PERS-06 | `reads/limit-must-report-remainder` — see the P1 above |
| PERS-10 | `fetch/blocked-must-not-read-as-empty` — a non-2xx may not reach a content parser; the same shape as the P0 storefront drop above |
| DISC-05 | `discovery/platform-is-never-manufacturer` |
| DISC-09 | `discovery/self-supplied-gate-must-fail-closed` — gates are fail-open today |
| OUT-04 | `outreach/one-thread-per-supplier` |
| OUT-08 | `outreach/asks-must-be-staged` |
| OUT-10 | `outreach/cancel-must-release-alias` |
| OUT-12 | `suppliers/approval-denied-is-not-do-not-contact` |
| ORG-06 | `orgs/name-lookup-must-scope-query` — see the P2 above |
| UI-02 | `ui/no-global-review-route` |
| UI-06 | `ui/flagged-set-must-have-a-surface` — see the P0 above |
| UI-11 | `ui/no-numeric-placeholder-in-value-field` — live on the marketplace-pricing card's per-unit field |
| SHIP-02 | pre-commit hook refusing unstaged paths — see the P2 above |
| SHIP-07 | `ship/migration-must-accompany-schema-read` |
| PRICING-01 | `shipping/cost-must-be-numeric` |
| PRICING-02 | `shipping/cost-per-tier` |
| PRICING-03 | `shipping/extraction-org-opt-in` |
| PRICING-05 | `shipping/no-fabricated-costs` — the per-tier estimator breaks it today, see the P2 above |

### Audit owed — no build check can see it, a scheduled job can

| Rule | The job |
| --- | --- |
| DATA-08 | daily: the arming value is stable for a material Tenkara has not edited, and no draft invites an adjacent grade — see the P1 above |
| PRICING-04 | daily: shipping capture rate against a threshold |
| PERS-07 | daily: withheld prices with no surface — see the P0 above |
| DISC-08 | daily: every paged source's cursor advanced, and the marker written is the marker read |
| OUT-09 | daily: conversations past their follow-up cadence with no outbound |

## Open decisions

None open.

`CONFLICTS.md` K (scope of the em dash ban), L (the dealbreaker grade rule) and
M (whether COMM-05 admits an explicit "post this as me") were all ruled on
2026-08-20. M was ruled no: COMM-05 is absolute.
