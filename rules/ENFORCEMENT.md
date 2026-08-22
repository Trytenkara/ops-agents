# Enforcement ledger

Generated from the Enforcement line of every rule by
`npm run gen:enforcement`. Do not edit by hand: the rule files are the
source of truth and this is only a view of them.

121 rules. 87 are actually enforced, 23 owe a check or a job,
20 are human judgement that nothing could ever check.

15 of the enforced rules hold only part of their invariant and say so in
their own Enforcement line. They are counted in both figures above.

| Status | Meaning | Count |
|---|---|---|
| **Guard** | A shared module or build check makes it impossible. | 79 |
| **Audit** | A scheduled job reports the break after the fact. | 8 |
| **Check owed** | A build check is possible and is not built yet. | 8 |
| **Judgement** | Nothing mechanical can ever verify it. Human, by design. | 20 |
| **Cross-reference** | Restates a rule enforced elsewhere. | 3 |
| **None** | Outside this repository. Cannot be checked here. | 2 |
| **Retired** | No longer applies. | 1 |

Anything "owed" is also listed in `OUTSTANDING.md`; the build refuses
otherwise, so a gap cannot go quiet.

**A guard binds a place, not a rule.** "Guard" below means guarded in the
place that line names, and two places are checked: this repository's `src/**`
on every build, and `/workspace/.claude/skills/**` on every commit to the
workspace repository. A rule can be genuinely enforced here and broken in an
agent skill, a migration or a one-off script. That is not hypothetical: four
skills went on posting to Slack channels `COMM-06` had retired for a day while
this ledger read as enforced.

## Guard (79)

| Rule | | Enforcement |
|---|---|---|
| `META-02` | Prefer a positive invariant over a blocklist | Guard — `src/lib/mailbox-domain.ts`, `contacts/no-inline-mailbox-list`. |
| `META-04` | One shared module per invariant | Guard for the invariants that have a `check-rules` id. Check owed — `meta/no-second-copy-of-a-shared-guard`, extending coverage to the rest. |
| `META-05` | Ad-hoc scripts live in `scripts/` and get deleted | Guard — `tsconfig.json` include scope. |
| `META-09` | A guard is not a guard until a deliberate break makes it fire | Guard — `npm run check:rules:self-test`, which runs ahead of `next build`, so an inert guard fails the deploy. It fails on two separate things: a mutation its check did not catch, and a check no mutation covers. Plus `scripts/install-hooks.mjs`, which installs both repositories' hooks from `npm install`, with `check-rules` refusing to pass locally while either has its hooks unset. |
| `COMM-05` | Never speak as the human | Guard — `comm/one-slack-sender`: `postSlackMessage` in `src/lib/slack.ts` is the only place that posts, and no user token may appear anywhere. `postAgentAlert` used to hold a second copy of the same fetch and now delegates to it. |
| `COMM-06` | One channel, one post a day | Guard — `comm/one-slack-channel` in `scripts/lib/rule-checks.mjs` rejects any channel argument, any of the retired channel env vars, and any Slack id that is not `C0B5M1QCE9E`, everywhere except `src/lib/slack.ts`. It runs over this repository in `npm run build` and over `/workspace/.claude/skills` in that repo's pre-commit hook, because the skills post to Slack too and four of them were found breaking this rule on 2026-08-20 while the ledger reported it enforced. |
| `COMM-07` | Everything an agent raises waits for the daily post | Guard — `dispatchAlert` queues every severity except p3; nothing else in the repo posts an agent alert. Fail-open is deliberate. |
| `COMM-08` | Copy bans | Guard — `sanitizeDraft` inside `stageDraft` at runtime, and `copy/no-rfq-or-em-dash-in-templates` at build time over a named scope of outbound-copy files, held closed by two companion checks: the scope paths are anchors, so renaming one fails the build rather than silently dropping it, and `copy/scope-must-cover-every-draft-site` makes any `stageDraft` caller missing from that scope a violation. Check owed — `copy/no-direct-draft-create`: two paths still create a draft on the platform without going through `stageDraft`, so neither guard sees them. See `OUTSTANDING.md`. |
| `COMM-09` | Never announce as a bot in a crawler user agent | Guard — `crawl/no-agent-identifying-user-agent`: a user agent naming the company or a crawler token fails the build. It is a check on the literal rather than on a shared constant, because there are six user agents in the fleet and consolidating them is a separate change; what matters is that none of them says who we are. The skills folder is only scanned when `check-rules` is run with `--also`, so a skill's fetcher is covered by the daily skills pass, not by the deploy build. |
| `AUTO-02` | Decide alone: volume of change | Guard — `src/lib/requirements-recheck.ts` `recheckOrgLeads`. |
| `AUTO-05` | Never touch: operator and org membership | Guard — `orgs/no-operator-membership-writes`: nothing writes `user_org_assignments` or `user_roles`, in the query builder or in raw SQL, outside three human-gated server actions. `operator_type` and lanes are columns of that table, so they are covered by covering the table. The allow-list is an exact path match, not a substring, so a new `bulk-operators.ts` is not admitted by resembling one that is. |
| `AUTO-06` | Cold outbound is never auto-sent | Guard — `outreach/no-send-outside-operator-action`: the send verbs are banned outright, since the fault would arrive as a convenience — an `auto_send` on a draft body, or a POST to a send endpoint from a night-time agent. Nothing in this codebase sends to a supplier today; the only real send is the operator invite, which is an account email to a colleague. |
| `AUTO-07` | Owner of an open record is derived, never trusted | Guard — `src/lib/operator-assignment.ts` `recordOwnerId`, `assignment/derive-owner-via-recordOwnerId`. |
| `AUTO-08` | Call tasks belong to call operators only | Guard — `assignment/call-owner-must-be-call-operator`, six mutations. The pool filter in `poolForWork` was read as holding this rule, but it only governs a fresh derivation, and a stamp can reach a case row two other ways. So the check holds all three: `src/lib/call-escalation.ts` must resolve the caller from the call side of the pool, every `type: "calling_escalation"` insert must take its owner from that router, and both re-derivation paths — `src/lib/org-cases.ts` at read time and `src/lib/reassign-owners.ts` when an operator is removed — must route a call over callers alone and write nobody rather than the email desk. `deriveCaseOwners` now clears a stored call stamp belonging to someone who is not a caller today, and operator removal reassigns `cases`, which it never touched. |
| `AUTO-09` | Real clients before internal test orgs | Guard — `src/lib/org-priority.ts`, `queues/no-inline-org-priority`. |
| `AUTO-10` | Near-duplicate supplier names reach one operator | Guard — `src/lib/operator-assignment.ts` `mergeSimilarNameKeys`, applied inside `getOrgLeadIndex` so every surface that resolves an owner shares one key map. |
| `AUTO-11` | The lead names the operator, every other surface follows | Guard — `src/lib/operator-assignment.ts` `orgAutoKey` resolves every row through the key map built from the leads and profiles, `supplierKind` resolves every lane name-first, and every derivation site goes through both. |
| `DATA-01` | Never fabricate, approximate or infer a price | Guard — `src/lib/price-publish.ts` `publishablePrice` / `publishableTiers` at every price writer, `price/writer-must-gate`, for the amount; `src/lib/price-provenance.ts` `verifyPriceProvenance`, `price/capture-must-carry-source-text`, for the basis (DATA-14). |
| `DATA-02` | A foreign price is published only through one conversion | Guard — `fx/no-direct-convertToUsd`. |
| `DATA-04` | Agents may never invent a contact detail in an outgoing body | Guard — `src/lib/contact-guard.ts`, `contacts/staging-must-guard-fabrication`. |
| `DATA-05` | Guessing a recipient is allowed; guessing content is not | Guard — `contacts/guessed-combo-requires-own-domain-and-flag`: the one branch in the repo that builds an address out of a name and a domain must keep both its `!isAggregatorDomain(...)` gate and its `guessed` confidence stamp. The two are checked together because each reads as redundant next to the other, so a cleanup removes one and leaves the rule half-true. The shared host list is owed: the gate reads a hand-copied copy in `enrich.ts` that has drifted 15 hosts behind `src/lib/aggregator-hosts.ts`, so a guess is still allowed on those hosts. |
| `DATA-06` | Only a same-run verification counts as a confirmed email | Guard — `VERIFYING_SOURCES` in `src/agents-runtime/agents/data-enrichment/enrich.ts`, `contacts/confidence-derived-from-source`. The check is on the derivation rather than the word: confidence must be computed from the source, the cache replay must be excluded, and no other line in the corpus may assign the literal. That last part is what stops the old shape coming back, since `= "verified"` reads like a harmless default at every call site that might add one. |
| `DATA-07` | Density: bulk for solids, specific gravity for liquids | Guard — `src/lib/quote-density-guard.ts` `validateQuoteDensity` called inside `insertStagedQuotes`, and `density/solids-require-bulk` in `scripts/lib/rule-checks.mjs` fails the build if the guard is removed. Partially held by the enrichment sanitiser for display. |
| `DATA-09` | Aliases never add a qualifier the input lacked | Guard — `GRADE_WORDS` in `src/lib/material-aliases.ts`. |
| `DATA-10` | A write that fails is never silent | Guard — unconditional `console.error` on insert failure in `insertStagedQuotes` (`src/lib/staged-quotes.ts`), plus the `quote_capture_silent` check in the QA watchdog, which fires when supplier replies keep arriving and nothing is staged from them. |
| `DATA-11` | An unstated currency is a question, never a dollar sign | Guard — `normalizeToUsd` in `src/lib/fx.ts` returns status `unknown` for a blank currency, which `insertStagedQuotes` stores as a null price with a needs-review note, and which the lead headline mirror in `src/lib/tenkara-inbound.ts` refuses to publish. Parsers return null rather than a default. |
| `DATA-12` | The same company held twice is surfaced, never merged | Guard — `findSupplierDupeSuspicions` and `findCrossLaneVersions` in `src/lib/supplier-dupe-suspicion.ts`, rendered on the per-client Suppliers tab. Both return labels only; neither writes. |
| `DATA-13` | An operator's correction re-anchors a price, it does not freeze it | Guard — `updateStagedQuote` in `src/app/actions/staged-quotes.ts` re-anchors and flags siblings; `operatorSet` in `src/lib/staged-quotes.ts` notes the later quote. |
| `DATA-14` | A captured price carries the words it was read from | Guard — `price/capture-must-carry-source-text`: `verifyPriceProvenance` in `src/lib/price-provenance.ts` is applied by `insertStagedQuotes` before the publish gate and again on the lead-headline mirror in `src/lib/tenkara-inbound.ts`; a price it cannot trace is stored as null with the reason and `needs_review`. The check also holds the two extractors to asking for the fragment, and holds `staged_quotes` to a `price_source_text` column (migration 0124). The backward half is the `unreconciled_quote` set in `src/lib/flagged-work.ts`, which runs the same reconciliation over stored rows on every load of the client's Overview tab, and `scripts/repair-unreconciled-quotes.mts`, which corrects the one class arithmetic can settle — a per-tonne price charged to a case that is not a tonne — and reports the rest rather than guessing. |
| `DATA-16` | Every rung of a tiered quote is its own row | Guard — `price/tier-rungs-never-collapse`: `dupKey`, `echoKey` and `pricelessKey` in `src/lib/staged-quotes.ts` fall back to `provenanceKey(price_source_text)` when there is no basis to tell two rungs apart, so rungs separate on the words they were read from. The check holds all three keys to it. |
| `DATA-17` | A later source fills a blank, it does not overwrite a checked value | Guard — `applySupplierStatedDetails` in `src/lib/supplier-profiles.ts`, the only path the reply handler writes a profile through; the direct-contact exception is carried by both `site_type` writes in `src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts`. |
| `PRICING-07` | A marketplace that deals by email becomes a second, direct supplier | Guard — `splitDirectLeadFromMarketplace` in `src/lib/marketplace-direct-split.ts`, which refuses a platform address, refuses a lead already split, and reuses an existing direct sibling instead of stacking a second one. |
| `PRICING-08` | A price row belongs to one lane and no writer may cross | Guard — `quote_profiles.lane`, not null, no default at the call site: `insertQuoteProfile` requires it, `seedQuoteProfilesFromStaged` reads and writes `direct` only, `syncQuoteProfilesFromMarketplace` reads and writes `marketplace` only, and the quotes tab groups by supplier and lane. |
| `PERS-01` | Only a structural verdict is terminal | Guard — `src/lib/retry-verdict.ts` `classifyFailure`. Check owed — `retry/verdict-must-use-shared-classifier`: only three call sites use it and two hand-rolled classifiers remain. See `OUTSTANDING.md`. |
| `PERS-02` | "Needs a human" is a display flag, never a queue exit | Guard — `queues/flag-must-not-exit-queue`, four mutations. No read may filter the flagged rows away, and a lead may only be parked against a case through `src/lib/lead-queue-holds.ts`, which records the case id and whose `releaseClosedHolds` gives the lead back the moment that case stops being open. Both halves are checked: deleting the sweep fails the build, and so does leaving it uncalled. |
| `PERS-03` | A zero-result pass is never "this market is empty" | Guard — `src/lib/dry-pass.ts` (`passOutcome`, `advanceDryPass`, `retryAfter`, `rowsOrThrow`) and `discovery/zero-must-not-be-terminal`, which fails the build if the helper stops naming all three outcomes, if any of the six sites stops going through it, or if the marketplace re-check goes back to writing a crash as a finding. |
| `PERS-04` | Retry limits are a spend control, and must be named | Guard — `retry/bound-must-be-declared`: a constant whose name says it bounds attempts, retries or dry passes must be named in this file. The guard holds the half that can be read from the source; the run-summary half is still owed and is listed in `OUTSTANDING.md`. |
| `PERS-05` | Never give up on a lead with no contact | Guard — `outreach/contactless-must-park-not-drop`. This used to name OUT-02's check. They are not the same break: OUT-02 is a storefront that was never given a channel, PERS-05 is a direct supplier actively set to `dropped` so the re-queue cannot see it. Sharing one id meant guarding either one would report both as held. |
| `PERS-06` | No hidden caps on a worklist | Guard, in two halves. The accidental cut — `src/lib/supabase-paging.ts` `selectAllPaged` and `src/lib/supabase/truncation-guard.ts`, `reads/client-must-guard-truncation`. The deliberate window — `reads/limit-must-report-remainder`, which fails any capped read of a work table that does not carry its own remainder out. `src/lib/capped-read.ts` is the runtime half (PostgREST returns the true count on the same request, so knowing what was left behind is free) and `src/components/showing-note.tsx` the page half. A window that genuinely hides no work is waived in the check's `DECLARED_WINDOWS`, keyed by file *and* by the exact constant, so renaming or moving it revokes the waiver. |
| `PERS-08` | The record of a failure is never proof of success | Guard — the reply-drafted check in `src/lib/tenkara-inbound.ts` excludes `unmatched_inbound_clarification` and `retireUnmatchedTriage` closes the case and the draft on a successful match; `replies/idempotency-must-exclude-triage-artefacts` fails the build if the check stops distinguishing them or the retirement is dropped. |
| `PERS-09` | A paced job stops itself and says where it stopped | Guard — `deadlineAt` on `syncOrgThreadOwners` (`src/lib/sync-thread-owners.ts`), threaded into both push loops, with `unpushed` in the run summary and the re-assert cursor rewound to the last thread actually pushed; `INTERACTIVE_SYNC_BUDGET_MS` at the server-action call sites. Check owed for the class — `runs/paced-loop-must-carry-deadline`, so a new per-item push loop with no deadline fails the build. See `OUTSTANDING.md`. |
| `PERS-10` | Blocked is not empty | Guard — `fetch/blocked-must-not-read-as-empty`, in three parts, because the rule breaks at two different points and the code broke at both while looking correct. |
| `DISC-01` | Search the trade's name, not ours | Guard — `discovery/source-must-use-alias-resolver`. Keyed on the write, not on a list of the sources we have: anything under `agents/lead-creator/` that inserts into `leads_in_flight` is a discovery source by definition, and has to name the aliases. A new source cannot skip it by not being on the list, because there is no list. |
| `DISC-02` | Aliases must reach the relevance filter too | Guard — `discovery/relevance-filter-must-accept-aliases`, anchored per filtering source, so deleting or renaming one is the violation rather than a quiet loss of coverage. |
| `DISC-03` | Aliases never re-specify (see DATA-09) | Guard — see DATA-09. |
| `DISC-05` | A platform is never the supplier | Guard — `discovery/platform-is-never-manufacturer`, four mutations. Both halves, because only the first was ever held: the scout refuses to stage a platform's own name as a company, and `stageDraft` refuses a recipient at a platform's own domain unless the platform is itself the company being written to. Both tests live in `src/lib/aggregator-hosts.ts` (`isAggregatorPlatformName`, `isPlatformOwnedContact`). The gate sits at the send rather than at each write because eighteen places stamp a contact email on a lead and one place sends to it. |
| `DISC-06` | Duplicate suppliers have one definition | Guard — `src/lib/lead-dupe-guard.ts`. |
| `DISC-07` | Same name, different grade, is not a duplicate | Guard — `materials/never-merge-on-name-alone`. It asserts the grade test runs in the same loop as the name match, so a pair cannot reach the candidate list on the name alone, and that nothing outside `src/lib/material-merge-flags.ts` writes `material_merge_flags` (META-04). |
| `DISC-09` | A self-supplied material is not sourced | Guard — `discovery/self-supplied-gate-must-fail-closed`, twelve mutations. `loadSelfSuppliedMaterials` returns whether it knows, and each of the five callers is checked both for asking and for handling the answer it may not get. |
| `DISC-10` | Checkout decides what a marketplace is | Guard — the price read downgrades any marketplace-labelled page with no checkout at the single read chokepoint (`marketplace_checkout` downgrade in `lead-price-pull.ts`), and the scout prompt applies the same test at classification time. |
| `OUT-02` | Marketplace storefronts get drafted, on a different channel | Guard — `outreach/no-terminal-drop-without-channel`. The aggregator inquiry channel itself is still owed; see `OUTSTANDING.md`. |
| `OUT-04` | One email per supplier, one thread | Guard — `outreach/one-thread-per-supplier`: the consolidation key must stay org-and-supplier only, and the single staging call must be fed the whole group. Adding the material to the key is the regression to expect — it looks like a fix for subject-line collisions and it sends one person four emails. Agent 22's operator path is not covered by this check; it stages one lead per call by design and avoids a second thread by CCing onto the existing one, which no static check can tell apart from the fault. |
| `OUT-05` | No draft into an existing thread may ignore what was already said | Guard — `src/lib/thread-context.ts`, `src/lib/thread-tailor.ts`, `copy/staging-must-tailor-to-thread`. |
| `OUT-06` | Internal notes never reach a supplier | Guard — `src/lib/internal-notes.ts` `stripInternalNotes` inside `sanitizeDraft`, `copy/sanitize-must-strip-internal-notes`. |
| `OUT-14` | Never offer to stop contacting a supplier | Guard — `CONCESSION_STRIPS` in `src/lib/email-style.ts`, run inside `sanitizeDraft` at the staging chokepoint so it covers model-written copy as well as templates, plus rule 5 of the `src/lib/thread-tailor.ts` prompt; `copy/sanitize-must-strip-concessions`. |
| `OUT-07` | Copy bans are applied at staging (see COMM-08) | Guard — `copy/staging-must-sanitize`. |
| `OUT-11` | A rejected draft is not redrafted | Guard — `src/lib/draft-suppression.ts` `isDraftSuppressed`, called by `stageDraft` and by Agent 02, which stages its own draft directly. |
| `OUT-12` | "denied" in Tenkara does not mean "do not contact" | Guard — `suppliers/approval-denied-is-not-do-not-contact`. Recorded because a guard was built on the wrong reading of this column on 2026-08-19 and removed the same day. The check is on the meaning rather than on the old symbol names, which are already deleted: the word `denied` may not reach a suppression verdict, and the denied set may not be read out of the suppliers table. The two display sites that legitimately bucket the column are allowed by name. |
| `OUT-13` | Do-not-contact has two authors, and one gate | Guard — `src/lib/do-not-contact.ts` `isDoNotContact`, called by `stageDraft`; the client list also still filters candidates in Agents 03 and 04. |
| `OUT-15` | A discard has to say why, or it is a silent kill | Guard — `src/lib/draft-suppression.ts` `raiseDiscardReviewCase`, called from the Tenkara discard webhook, which is the only place an operator discard is recorded. |
| `ORG-01` | Every idempotency key is scoped to the organisation | Guard — `src/lib/org-isolation.ts` `orgScopedExternalId`, `orgScopedKey`, `foreignOrgRows`; `orgs/staging-must-scope-external-id` and `orgs/conversation-create-must-scope-external-id`. |
| `ORG-02` | Never fold leads from two clients into one draft | Guard — `foreignOrgRows`. |
| `ORG-03` | Shared natural keys carry the organisation in the database too | Guard — `orgs/upsert-conflict-key-must-include-org` plus the schema migrations. |
| `ORG-04` | An ambiguous inbound reply goes to triage, not to a guess | Guard — `soleOrgOwner`. |
| `ORG-08` | Membership in `organization_ids` tests the whole set, never a fixed slot | Guard — `orgs/no-fixed-index-org-membership`. |
| `ORG-09` | A supplier shared across clients never suppresses a client-owned supplier | Guard — `orgs/duplicate-guard-requires-exclusive-supplier`. |
| `ORG-10` | A supplier id is checked against its owners before it is stored | Guard — the shared resolver `scopedSupplierId` in `src/lib/tenkara-supplier-linker.ts`, and `orgs/supplier-id-written-must-be-scoped`, which fails the build on both arrival paths: a `draft_references` write taking an id off a row, and any agent API route storing an id off the request body. |
| `ORG-11` | Unknown is not ambiguous | Guard — `soleReplyTarget` in `src/lib/org-isolation.ts`, `orgs/candidate-match-must-not-key-on-null`, which fails the build on a `supplier_id ?? ""` or `material_id ?? ""` match key in the inbound router. |
| `ORG-12` | A reply belongs to the client whose thread it is on | Guard — `orgs/inbound-org-must-try-the-thread`, which fails the build if `resolveInboundOrg` in `src/lib/tenkara-inbound.ts` gives up without asking `draft_references` for the conversation's owner, or if it takes an owner from a thread that names more than one. |
| `SUP-01` | Suppliers are unique per client | Guard — `orgs/duplicate-guard-requires-exclusive-supplier` covers the online guard; the hand-run scan unions pairs only when their client sets intersect, enforced in its own code outside this repository. |
| `UI-01` | Never ship a native OS dropdown | Guard — `ui/no-native-select`. |
| `UI-02` | Everything lives on the client's own tabs | Guard — `ui/no-global-review-route`, as a ratchet. Seven routes under `work/review/` predate the rule and are named in the check; an eighth fails the build. The seven are owed: they are live and cross-client, and the debt is paid down by removing names from that list, never by adding them. Deleting them is a product decision, not a cleanup. |
| `UI-06` | Flagged work needs a home | Guard — `ui/flagged-set-must-have-a-surface`. A home for audit findings is owed: they are persisted nowhere, so they are not yet in the registry the guard reads; see `OUTSTANDING.md`. |
| `UI-09` | A one-click write needs a way back | Guard — `src/lib/call-undo.ts` `undoLastAttemptPatch`, surfaced by `UndoCallAttempt` on both the open call task and the recently-closed table. Judgement for other one-click controls. |
| `UI-10` | A withheld value shows its reason where it renders | Guard — the withheld-price cells in `src/components/staged-quote-row.tsx` and `src/components/direct-prices-on-file.tsx` (`priceNote`), which render the capture reason and carry it into the CSV. Judgement for other withheld fields. |
| `UI-11` | A placeholder must never look like a value | Guard — `ui/no-numeric-placeholder-in-value-field`: a placeholder whose whole text is a number fails the build. A unit (`kg`), a format (`price per unit`) or an explicit `e.g.` stays legal, which is what the fix looks like. The three live breaks on the marketplace-pricing card — case size, case price, unit price — were fixed with the check. |
| `SHIP-03` | A red build is silent, so build before you push | Guard — pre-push hook, on machines that ran `npm install`. |
| `SHIP-04` | Rules are checked before the build | Guard. |
| `SHIP-07` | Deploy and schema move together | Guard — `ship/migration-must-accompany-schema-read`: every table read through `.from(...)` and every `.rpc(...)` must be created by a migration in this repo. That is the granularity that can be read statically and the one that fails every call rather than one field; a missing *column* is still owed and is listed in `OUTSTANDING.md`. The check also fails if no migrations are in the corpus at all, since an empty schema would otherwise read as "nothing to check". |

## Audit (8)

| Rule | | Enforcement |
|---|---|---|
| `DATA-08` | A dealbreaker grade is a hard specification | Audit — Agent 26 compares, per material, what our drafts actually asked for against what Tenkara flags as a dealbreaker today, and reports every material where the two disagree in either direction: armed when the client flags nothing, unarmed when the client flags a grade. It is keyed on the resolved grade string and not on `updated_at`, because Tenkara rewrites every material nightly at 00:00:02 UTC, so a staleness test keyed on the timestamp sees a changed record every day and reports nothing. The audit reports and repairs nothing: the 7 disagreeing materials, and the widening phrasings the blocking code still misses, are owed. |
| `DATA-15` | Extraction records what it did not take | Audit — `agent-24-price-capture-reconcile`. Every inbound message writes `message_price_capture` (migration 0125) with the price points the extractor counted before extracting and the rows actually accounted for; Agent 24 re-reads the shortfalls daily and alerts on the confirmed ones. Per META-07 the second read is a model read, never a price regex, and it reports rather than stages — the first read already got that message wrong once. |
| `PRICING-04` | Delivery-cost extraction is audited every run | Audit — Agent 26 counts four things daily and reports the gap between them: listings pulled, rows carrying the delivery-cost keys, attempts made, and numbers captured. The distinction matters more than the rate. A key present with a null under it says the writer ran; a number says it produced something; zero attempts against thousands of pulls says the feature is inert, which is exactly the state it shipped in and held for weeks. The audit reports the inert case as its own finding rather than as a capture rate of zero. The fix is owed: `getOrgShipToAddress` selects `ship_to_*` columns that do not exist on this project's `orgs` table and the catch swallows it, which is why there are zero attempts against 4,044 pulled listings. |
| `PERS-07` | A withheld price is a job, not an outcome | Audit — Agent 26 counts withheld prices carrying no reason every morning and reports them with the oldest date. On the day it shipped all 19 withheld prices in the system had no reason recorded, so the count is a real measure and not a formality. Check owed for the second half: the surface itself on the client's own tab (UI-06). Until that exists a person still has to read the audit to find these rows, which is why the audit is the weaker of the two. See `OUTSTANDING.md`. |
| `DISC-08` | A source's own paging must advance | Audit — Agent 26 reads the discovery agent's stored state daily and reports two shapes of the same fault: a credit-gate marker saved without the `done` key the reader looks for, and a page cursor nobody writes any more. The first is the dangerous one, because the reader treats a missing `done` as finished, so a marker written under the wrong shape gates its material off that source permanently. All 15 SourceReady markers were in that state when the audit shipped, alongside 52 orphaned page cursors. Clearing them is owed — until somebody does, each one reads as finished and gates its material off SourceReady for good. |
| `OUT-09` | Stalled conversations get chased | Audit — Agent 26 reports conversations past the gap with nothing sent, and separately the ones exempt only because a draft has sat staged on them for more than fourteen days. The exemption is the half worth watching: a thread is not chased while an operator has something waiting on it, and that is evaluated over the whole thread, so one draft nobody ever actioned stops the sequence for good. On its first production run the audit found the cadence itself healthy — nothing overdue with an empty outbox — and one thread held by a draft staged more than fourteen days earlier. That is the shape to watch, not the count: 3,461 drafts are sitting staged fleet-wide, so the number of threads this can silence is bounded by how many of them go unactioned. Capping the exemption is owed, and is a product decision rather than a check. |
| `ORG-05` | The live data is audited every morning | Audit — the daily organisation-isolation audit. |
| `SHIP-08` | Weekly rules review | Audit — `agent-25-rules-review`, weekly. It reads a snapshot of the rulebook generated at build time, and the build refuses if that snapshot has drifted from the rule files, so the review cannot report a rulebook that no longer exists. |

## Check owed (8)

| Rule | | Enforcement |
|---|---|---|
| `PRICING-01` | A shipping cost is a number or it is nothing | Check owed — `shipping/cost-must-be-numeric`. |
| `PRICING-02` | Delivery cost is per pack tier when pack size changes it | Check owed — `shipping/cost-per-tier`. |
| `PRICING-03` | Delivery-cost extraction is opt-in per client | Check owed — `shipping/extraction-org-opt-in`. |
| `PRICING-05` | A delivery cost is never fabricated | Check owed — `shipping/no-fabricated-costs`. |
| `OUT-08` | Supplier asks are staggered | Check owed — `outreach/asks-must-be-staged`. |
| `OUT-10` | A cancelled outreach must release its alias | Check owed — `outreach/cancel-must-release-alias`. |
| `ORG-06` | Cross-client lookups are scoped at the query, not filtered after | Check owed — `orgs/name-lookup-must-scope-query`, plus an outstanding repair of the records already mislabelled. See `OUTSTANDING.md`. |
| `SHIP-02` | Never stage everything | Check owed — a pre-commit hook that refuses paths outside those explicitly staged. See `OUTSTANDING.md`. |

## Judgement (20)

| Rule | | Enforcement |
|---|---|---|
| `META-01` | Every rule and correction becomes code, permanently | Judgement. Process rule; partially visible via `scripts/check-rules.mjs` coverage and the weekly review (SHIP-08). |
| `META-03` | Never route around a broken shared component | Judgement. Visible only because a workaround must be written into `OUTSTANDING.md` when it is made. |
| `META-06` | Always verify current live status; never answer from memory | Judgement. |
| `META-07` | Read, do not pattern-match | Judgement. |
| `META-08` | Never filter your own diagnostic output | Judgement. |
| `COMM-01` | Keep replies short | Judgement. |
| `COMM-02` | Write for a non-developer | Judgement. |
| `COMM-03` | Claim only what a command proved | Judgement. This is the rule whose breach reads as "fake pushing". |
| `COMM-04` | Report the outcome, keep the receipts | Judgement. |
| `AUTO-01` | Decide alone: anything reversible inside the pipeline | Judgement. |
| `AUTO-03` | Escalate: a real tradeoff, not a guess about one | Judgement. |
| `AUTO-04` | Escalate: anything irreversible or outside the pipeline | Judgement. |
| `DATA-03` | FX rates refresh daily, not intraday | Judgement. |
| `PRICING-06` | The primary price pull runs on the fleet's own platform | Judgement. |
| `UI-03` | Never build a screen over data this application cannot write to | Judgement. |
| `UI-04` | The Inbox is a triage queue, not an email client | Judgement. |
| `UI-05` | Clutter is a bug, not a tradeoff | Judgement. |
| `UI-07` | Seed a real client before judging a view | Judgement. |
| `SHIP-01` | Push to `main` | Judgement. |
| `SHIP-05` | Confirm what production is actually serving | Judgement. This is the rule whose breach reads as "fake pushing". |

## Cross-reference (3)

| Rule | | Enforcement |
|---|---|---|
| `DISC-04` | Zero is not empty (see PERS-03) | See PERS-03. |
| `OUT-01` | Nothing auto-sends (see AUTO-06) | See AUTO-06. |
| `OUT-03` | Never guess a contact on a platform host (see DATA-05) | See DATA-05. |

## None (2)

| Rule | | Enforcement |
|---|---|---|
| `ORG-07` | Unaudited edge | None. Known gap. |
| `SHIP-06` | The deploy gate must not depend on one machine | None. A workflow file exists on disk but has never been committed, because the token used to push is not permitted to create one. See `OUTSTANDING.md`. This is the single largest hole in the shipping process. |

## Retired (1)

| Rule | | Enforcement |
|---|---|---|
| `UI-08` | RETIRED: the CSV export sweep | Retired 2026-08-19. |
