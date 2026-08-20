# Enforcement ledger

Generated from the Enforcement line of every rule by
`npm run gen:enforcement`. Do not edit by hand: the rule files are the
source of truth and this is only a view of them.

118 rules. 56 are actually enforced, 42 owe a check or a job,
20 are human judgement that nothing could ever check.

6 of the enforced rules hold only part of their invariant and say so in
their own Enforcement line. They are counted in both figures above.

| Status | Meaning | Count |
|---|---|---|
| **Guard** | A shared module or build check makes it impossible. | 54 |
| **Audit** | A scheduled job reports the break after the fact. | 2 |
| **Check owed** | A build check is possible and is not built yet. | 30 |
| **Audit owed** | No build check can see it; a scheduled job can. Not built. | 6 |
| **Judgement** | Nothing mechanical can ever verify it. Human, by design. | 20 |
| **Cross-reference** | Restates a rule enforced elsewhere. | 3 |
| **None** | Outside this repository. Cannot be checked here. | 2 |
| **Retired** | No longer applies. | 1 |

Anything "owed" is also listed in `OUTSTANDING.md`; the build refuses
otherwise, so a gap cannot go quiet.

## Guard (54)

| Rule | | Enforcement |
|---|---|---|
| `META-02` | Prefer a positive invariant over a blocklist | Guard — `src/lib/mailbox-domain.ts`, `contacts/no-inline-mailbox-list`. |
| `META-04` | One shared module per invariant | Guard for the invariants that have a `check-rules` id. Check owed — `meta/no-second-copy-of-a-shared-guard`, extending coverage to the rest. |
| `META-05` | Ad-hoc scripts live in `scripts/` and get deleted | Guard — `tsconfig.json` include scope. |
| `META-09` | A guard is not a guard until a deliberate break makes it fire | Guard — `npm run check:rules:self-test`, which runs ahead of `next build`, so an inert guard fails the deploy. |
| `COMM-06` | One channel, one post a day | Guard — `comm/one-slack-channel` in `scripts/check-rules.mjs` rejects any channel argument, any hardcoded `C0…`/`D0…` id and any of the retired channel env vars, everywhere except `src/lib/slack.ts`. |
| `COMM-07` | Everything an agent raises waits for the daily post | Guard — `dispatchAlert` queues every severity except p3; nothing else in the repo posts an agent alert. Fail-open is deliberate. |
| `COMM-08` | Copy bans | Guard — `sanitizeDraft` inside `stageDraft` at runtime, and `copy/no-rfq-or-em-dash-in-templates` at build time over a named scope of outbound-copy files, held closed by two companion checks: the scope paths are anchors, so renaming one fails the build rather than silently dropping it, and `copy/scope-must-cover-every-draft-site` makes any `stageDraft` caller missing from that scope a violation. Check owed — `copy/no-direct-draft-create`: two paths still create a draft on the platform without going through `stageDraft`, so neither guard sees them. See `OUTSTANDING.md`. |
| `AUTO-02` | Decide alone: volume of change | Guard — `src/lib/requirements-recheck.ts` `recheckOrgLeads`. |
| `AUTO-07` | Owner of an open record is derived, never trusted | Guard — `src/lib/operator-assignment.ts` `recordOwnerId`, `assignment/derive-owner-via-recordOwnerId`. |
| `AUTO-09` | Real clients before internal test orgs | Guard — `src/lib/org-priority.ts`, `queues/no-inline-org-priority`. |
| `AUTO-10` | Near-duplicate supplier names reach one operator | Guard — `src/lib/operator-assignment.ts` `mergeSimilarNameKeys`, applied inside `getOrgLeadIndex` so every surface that resolves an owner shares one key map. |
| `AUTO-11` | The lead names the operator, every other surface follows | Guard — `src/lib/operator-assignment.ts` `orgAutoKey` resolves every row through the key map built from the leads and profiles, `supplierKind` resolves every lane name-first, and every derivation site goes through both. |
| `DATA-01` | Never fabricate, approximate or infer a price | Guard — `src/lib/price-publish.ts` `publishablePrice` / `publishableTiers` at every price writer, `price/writer-must-gate`, for the amount; `src/lib/price-provenance.ts` `verifyPriceProvenance`, `price/capture-must-carry-source-text`, for the basis (DATA-14). |
| `DATA-02` | A foreign price is published only through one conversion | Guard — `fx/no-direct-convertToUsd`. |
| `DATA-04` | Agents may never invent a contact detail in an outgoing body | Guard — `src/lib/contact-guard.ts`, `contacts/staging-must-guard-fabrication`. |
| `DATA-09` | Aliases never add a qualifier the input lacked | Guard — `GRADE_WORDS` in `src/lib/material-aliases.ts`. |
| `DATA-10` | A write that fails is never silent | Guard — unconditional `console.error` on insert failure in `insertStagedQuotes` (`src/lib/staged-quotes.ts`), plus the `quote_capture_silent` check in the QA watchdog, which fires when supplier replies keep arriving and nothing is staged from them. |
| `DATA-11` | An unstated currency is a question, never a dollar sign | Guard — `normalizeToUsd` in `src/lib/fx.ts` returns status `unknown` for a blank currency, which `insertStagedQuotes` stores as a null price with a needs-review note, and which the lead headline mirror in `src/lib/tenkara-inbound.ts` refuses to publish. Parsers return null rather than a default. |
| `DATA-12` | The same company held twice is surfaced, never merged | Guard — `findSupplierDupeSuspicions` and `findCrossLaneVersions` in `src/lib/supplier-dupe-suspicion.ts`, rendered on the per-client Suppliers tab. Both return labels only; neither writes. |
| `DATA-13` | An operator's correction re-anchors a price, it does not freeze it | Guard — `updateStagedQuote` in `src/app/actions/staged-quotes.ts` re-anchors and flags siblings; `operatorSet` in `src/lib/staged-quotes.ts` notes the later quote. |
| `DATA-14` | A captured price carries the words it was read from | Guard — `price/capture-must-carry-source-text`: `verifyPriceProvenance` in `src/lib/price-provenance.ts` is applied by `insertStagedQuotes` before the publish gate and again on the lead-headline mirror in `src/lib/tenkara-inbound.ts`; a price it cannot trace is stored as null with the reason and `needs_review`. The check also holds the two extractors to asking for the fragment, and holds `staged_quotes` to a `price_source_text` column (migration 0124). |
| `DATA-16` | Every rung of a tiered quote is its own row | Guard — `price/tier-rungs-never-collapse`: `dupKey`, `echoKey` and `pricelessKey` in `src/lib/staged-quotes.ts` fall back to `provenanceKey(price_source_text)` when there is no basis to tell two rungs apart, so rungs separate on the words they were read from. The check holds all three keys to it. |
| `DATA-17` | A later source fills a blank, it does not overwrite a checked value | Guard — `applySupplierStatedDetails` in `src/lib/supplier-profiles.ts`, the only path the reply handler writes a profile through; the direct-contact exception is carried by both `site_type` writes in `src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts`. |
| `PRICING-07` | A marketplace that deals by email becomes a second, direct supplier | Guard — `splitDirectLeadFromMarketplace` in `src/lib/marketplace-direct-split.ts`, which refuses a platform address, refuses a lead already split, and reuses an existing direct sibling instead of stacking a second one. |
| `PRICING-08` | A price row belongs to one lane and no writer may cross | Guard — `quote_profiles.lane`, not null, no default at the call site: `insertQuoteProfile` requires it, `seedQuoteProfilesFromStaged` reads and writes `direct` only, `syncQuoteProfilesFromMarketplace` reads and writes `marketplace` only, and the quotes tab groups by supplier and lane. |
| `PERS-01` | Only a structural verdict is terminal | Guard — `src/lib/retry-verdict.ts` `classifyFailure`. Check owed — `retry/verdict-must-use-shared-classifier`: only three call sites use it and two hand-rolled classifiers remain. See `OUTSTANDING.md`. |
| `PERS-06` | No hidden caps on a worklist | Guard for the accidental cut — `src/lib/supabase-paging.ts` `selectAllPaged` and `src/lib/supabase/truncation-guard.ts`, `reads/client-must-guard-truncation`. Check owed — `reads/limit-must-report-remainder` for deliberate windows. |
| `PERS-08` | The record of a failure is never proof of success | Guard — the reply-drafted check in `src/lib/tenkara-inbound.ts` excludes `unmatched_inbound_clarification` and `retireUnmatchedTriage` closes the case and the draft on a successful match; `replies/idempotency-must-exclude-triage-artefacts` fails the build if the check stops distinguishing them or the retirement is dropped. |
| `PERS-09` | A paced job stops itself and says where it stopped | Guard — `deadlineAt` on `syncOrgThreadOwners` (`src/lib/sync-thread-owners.ts`), threaded into both push loops, with `unpushed` in the run summary and the re-assert cursor rewound to the last thread actually pushed; `INTERACTIVE_SYNC_BUDGET_MS` at the server-action call sites. Check owed for the class — `runs/paced-loop-must-carry-deadline`, so a new per-item push loop with no deadline fails the build. See `OUTSTANDING.md`. |
| `DISC-01` | Search the trade's name, not ours | Guard — shared resolver, threaded into all three sources. Check owed — `discovery/source-must-use-alias-resolver`, so a NEW source cannot skip it. |
| `DISC-03` | Aliases never re-specify (see DATA-09) | Guard — see DATA-09. |
| `DISC-06` | Duplicate suppliers have one definition | Guard — `src/lib/lead-dupe-guard.ts`. |
| `DISC-10` | Checkout decides what a marketplace is | Guard — the price read downgrades any marketplace-labelled page with no checkout at the single read chokepoint (`marketplace_checkout` downgrade in `lead-price-pull.ts`), and the scout prompt applies the same test at classification time. |
| `OUT-05` | No draft into an existing thread may ignore what was already said | Guard — `src/lib/thread-context.ts`, `src/lib/thread-tailor.ts`, `copy/staging-must-tailor-to-thread`. |
| `OUT-06` | Internal notes never reach a supplier | Guard — `src/lib/internal-notes.ts` `stripInternalNotes` inside `sanitizeDraft`, `copy/sanitize-must-strip-internal-notes`. |
| `OUT-14` | Never offer to stop contacting a supplier | Guard — `CONCESSION_STRIPS` in `src/lib/email-style.ts`, run inside `sanitizeDraft` at the staging chokepoint so it covers model-written copy as well as templates, plus rule 5 of the `src/lib/thread-tailor.ts` prompt; `copy/sanitize-must-strip-concessions`. |
| `OUT-07` | Copy bans are applied at staging (see COMM-08) | Guard — `copy/staging-must-sanitize`. |
| `OUT-11` | A rejected draft is not redrafted | Guard — `src/lib/draft-suppression.ts` `isDraftSuppressed`, called by `stageDraft` and by Agent 02, which stages its own draft directly. |
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
| `SUP-01` | Suppliers are unique per client | Guard — `orgs/duplicate-guard-requires-exclusive-supplier` covers the online guard; the hand-run scan unions pairs only when their client sets intersect, enforced in its own code outside this repository. |
| `UI-01` | Never ship a native OS dropdown | Guard — `ui/no-native-select`. |
| `UI-09` | A one-click write needs a way back | Guard — `src/lib/call-undo.ts` `undoLastAttemptPatch`, surfaced by `UndoCallAttempt` on both the open call task and the recently-closed table. Judgement for other one-click controls. |
| `UI-10` | A withheld value shows its reason where it renders | Guard — the withheld-price cells in `src/components/staged-quote-row.tsx` and `src/components/direct-prices-on-file.tsx` (`priceNote`), which render the capture reason and carry it into the CSV. Judgement for other withheld fields. |
| `SHIP-03` | A red build is silent, so build before you push | Guard — pre-push hook, on machines that ran `npm install`. |
| `SHIP-04` | Rules are checked before the build | Guard. |

## Audit (2)

| Rule | | Enforcement |
|---|---|---|
| `DATA-15` | Extraction records what it did not take | Audit — `agent-24-price-capture-reconcile`. Every inbound message writes `message_price_capture` (migration 0125) with the price points the extractor counted before extracting and the rows actually accounted for; Agent 24 re-reads the shortfalls daily and alerts on the confirmed ones. Per META-07 the second read is a model read, never a price regex, and it reports rather than stages — the first read already got that message wrong once. |
| `ORG-05` | The live data is audited every morning | Audit — the daily organisation-isolation audit. |

## Check owed (30)

| Rule | | Enforcement |
|---|---|---|
| `COMM-05` | Never speak as the human | Check owed — `comm/one-slack-sender`: a single send helper that accepts only the bot token, and no user token anywhere. |
| `COMM-09` | Never announce as a bot in a crawler user agent | Check owed — `crawl/no-agent-identifying-user-agent`. |
| `AUTO-05` | Never touch: operator and org membership | Check owed — `orgs/no-operator-membership-writes`: no code path inserts, deletes or retypes an operator or an org membership. |
| `AUTO-06` | Cold outbound is never auto-sent | Check owed — `outreach/no-send-outside-operator-action`, plus the existing `COLD_OUTBOUND` flag. |
| `AUTO-08` | Call tasks belong to call operators only | Check owed — `assignment/call-owner-must-be-call-operator`. Partially held today by the operator-type pool filter. |
| `DATA-05` | Guessing a recipient is allowed; guessing content is not | Check owed — `contacts/guessed-combo-requires-own-domain-and-flag`: reject a guessed combo on a known platform host, and require the guessed flag. |
| `DATA-06` | Only a same-run verification counts as a confirmed email | Check owed — `contacts/confidence-derived-from-source`: confidence is derived from the source, and a same-run provider verdict is persisted. |
| `DATA-07` | Density: bulk for solids, specific gravity for liquids | Check owed — `density/solids-require-bulk`. Partially held today by the enrichment sanitiser. |
| `PRICING-01` | A shipping cost is a number or it is nothing | Check owed — `shipping/cost-must-be-numeric`. |
| `PRICING-02` | Delivery cost is per pack tier when pack size changes it | Check owed — `shipping/cost-per-tier`. |
| `PRICING-03` | Delivery-cost extraction is opt-in per client | Check owed — `shipping/extraction-org-opt-in`. |
| `PRICING-05` | A delivery cost is never fabricated | Check owed — `shipping/no-fabricated-costs`. |
| `PERS-02` | "Needs a human" is a display flag, never a queue exit | Check owed — `queues/flag-must-not-exit-queue`. |
| `PERS-03` | A zero-result pass is never "this market is empty" | Check owed — `discovery/zero-must-not-be-terminal`, over one shared dry-pass helper. Honoured per source today. See `OUTSTANDING.md`. |
| `PERS-04` | Retry limits are a spend control, and must be named | Check owed — `retry/bound-must-be-declared`: a bounded retry must name its bound here and in the run summary. |
| `PERS-05` | Never give up on a lead with no contact | Check owed — `outreach/no-terminal-drop-without-channel`. A scheduled sweep compensates today, which is a workaround under META-03 and is named in `OUTSTANDING.md`. |
| `DISC-02` | Aliases must reach the relevance filter too | Check owed — `discovery/relevance-filter-must-accept-aliases`. |
| `DISC-05` | A platform is never the supplier | Check owed — `discovery/platform-is-never-manufacturer`. |
| `DISC-07` | Same name, different grade, is not a duplicate | Check owed — `materials/never-merge-on-name-alone`. |
| `DISC-09` | A self-supplied material is not sourced | Check owed — `discovery/self-supplied-gate-must-fail-closed`: the gates are fail-open today. |
| `OUT-02` | Marketplace storefronts get drafted, on a different channel | Check owed — `outreach/no-terminal-drop-without-channel`. See `OUTSTANDING.md`. |
| `OUT-04` | One email per supplier, one thread | Check owed — `outreach/one-thread-per-supplier`. |
| `OUT-08` | Supplier asks are staggered | Check owed — `outreach/asks-must-be-staged`. |
| `OUT-10` | A cancelled outreach must release its alias | Check owed — `outreach/cancel-must-release-alias`. |
| `OUT-12` | "denied" in Tenkara does not mean "do not contact" | Check owed — `suppliers/approval-denied-is-not-do-not-contact`. Recorded because a guard was built on the wrong reading of this column on 2026-08-19 and removed the same day. |
| `ORG-06` | Cross-client lookups are scoped at the query, not filtered after | Check owed — `orgs/name-lookup-must-scope-query`, plus an outstanding repair of the records already mislabelled. See `OUTSTANDING.md`. |
| `UI-02` | Everything lives on the client's own tabs | Check owed — `ui/no-global-review-route`. |
| `UI-06` | Flagged work needs a home | Check owed — `ui/flagged-set-must-have-a-surface`. See `OUTSTANDING.md`. |
| `SHIP-02` | Never stage everything | Check owed — a pre-commit hook that refuses paths outside those explicitly staged. See `OUTSTANDING.md`. |
| `SHIP-07` | Deploy and schema move together | Check owed — `ship/migration-must-accompany-schema-read`. |

## Audit owed (6)

| Rule | | Enforcement |
|---|---|---|
| `DATA-08` | A dealbreaker grade is a hard specification | Audit owed — a daily check that a client with a stated required grade has it set on the record, and that no draft invites an adjacent grade. Held today by a QA lint that is inert when the field is unset. |
| `PRICING-04` | Delivery-cost extraction is audited every run | Audit owed — daily shipping-capture health job, `shipping/health-must-monitor-extraction-rate`. |
| `PERS-07` | A withheld price is a job, not an outcome | Audit owed — a daily count of withheld prices with no surface, plus the surface itself on the client's own tab (see `80-control-room.md`). See `OUTSTANDING.md`. |
| `DISC-08` | A source's own paging must advance | Audit owed — a daily check that every paged source's cursor advanced, and that the marker written is the marker read. A credit gate once wrote its marker under one key and read it under another, so it never fired and the source re-ran every pass. |
| `OUT-09` | Stalled conversations get chased | Audit owed — a daily report of conversations past their follow-up cadence with no outbound. |
| `SHIP-08` | Weekly rules review | Audit owed — a weekly scheduled task that assembles the review. |

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
