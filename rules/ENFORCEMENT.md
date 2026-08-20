# Enforcement ledger

Generated from the Enforcement line of every rule by
`npm run gen:enforcement`. Do not edit by hand: the rule files are the
source of truth and this is only a view of them.

116 rules. 53 are actually enforced, 37 owe a check or a job,
20 are human judgement that nothing could ever check.

| Status | Meaning | Count |
|---|---|---|
| **Guard** | A shared module or build check makes it impossible. | 51 |
| **Audit** | A scheduled job reports the break after the fact. | 2 |
| **Check owed** | A build check is possible and is not built yet. | 31 |
| **Audit owed** | No build check can see it; a scheduled job can. Not built. | 6 |
| **Judgement** | Nothing mechanical can ever verify it. Human, by design. | 20 |
| **Cross-reference** | Restates a rule enforced elsewhere. | 3 |
| **None** | Outside this repository. Cannot be checked here. | 2 |
| **Retired** | No longer applies. | 1 |

Anything "owed" is also listed in `OUTSTANDING.md`; the build refuses
otherwise, so a gap cannot go quiet.

## Guard (51)

| Rule | | Enforcement |
|---|---|---|
| `META-02` | Prefer a positive invariant over a blocklist | Guard — `src/lib/mailbox-domain.ts`, |
| `META-04` | One shared module per invariant | Guard for the invariants that have a `check-rules` id. |
| `META-05` | Ad-hoc scripts live in `scripts/` and get deleted | Guard — `tsconfig.json` include scope. |
| `COMM-06` | One channel, one post a day | Guard — `comm/one-slack-channel` in `scripts/check-rules.mjs` |
| `COMM-07` | Everything an agent raises waits for the daily post | Guard — `dispatchAlert` queues every severity except p3; |
| `COMM-08` | Copy bans | Guard — `sanitizeDraft` inside `stageDraft`, plus |
| `AUTO-02` | Decide alone: volume of change | Guard — `src/lib/requirements-recheck.ts` `recheckOrgLeads`. |
| `AUTO-07` | Owner of an open record is derived, never trusted | Guard — `src/lib/operator-assignment.ts` `recordOwnerId`, |
| `AUTO-09` | Real clients before internal test orgs | Guard — `src/lib/org-priority.ts`, |
| `AUTO-10` | Near-duplicate supplier names reach one operator | Guard — `src/lib/operator-assignment.ts` |
| `AUTO-11` | The lead names the operator, every other surface follows | Guard — `src/lib/operator-assignment.ts` `orgAutoKey` resolves |
| `DATA-01` | Never fabricate, approximate or infer a price | Guard — `src/lib/price-publish.ts` `publishablePrice` / |
| `DATA-02` | A foreign price is published only through one conversion | Guard — `fx/no-direct-convertToUsd`. |
| `DATA-04` | Agents may never invent a contact detail in an outgoing body | Guard — `src/lib/contact-guard.ts`, |
| `DATA-09` | Aliases never add a qualifier the input lacked | Guard — `GRADE_WORDS` in `src/lib/material-aliases.ts`. |
| `DATA-10` | A write that fails is never silent | Guard — unconditional `console.error` on insert failure in |
| `DATA-11` | An unstated currency is a question, never a dollar sign | Guard — `normalizeToUsd` in `src/lib/fx.ts` returns status |
| `DATA-12` | The same company held twice is surfaced, never merged | Guard — `findSupplierDupeSuspicions` and |
| `DATA-13` | An operator's correction re-anchors a price, it does not freeze it | Guard — `updateStagedQuote` in |
| `DATA-14` | A captured price carries the words it was read from | Guard — `price/capture-must-carry-source-text`: |
| `DATA-16` | Every rung of a tiered quote is its own row | Guard — `price/tier-rungs-never-collapse`: `dupKey`, `echoKey` |
| `DATA-17` | A later source fills a blank, it does not overwrite a checked value | Guard — `applySupplierStatedDetails` in |
| `PRICING-07` | A marketplace that deals by email becomes a second, direct supplier | Guard — `splitDirectLeadFromMarketplace` in |
| `PERS-01` | Only a structural verdict is terminal | Guard — `src/lib/retry-verdict.ts` `classifyFailure`. Owed: |
| `PERS-06` | No hidden caps on a worklist | Guard for the accidental cut — `src/lib/supabase-paging.ts` |
| `PERS-08` | The record of a failure is never proof of success | Guard — the reply-drafted check in `src/lib/tenkara-inbound.ts` |
| `DISC-01` | Search the trade's name, not ours | Guard — shared resolver, threaded into all three sources. |
| `DISC-03` | Aliases never re-specify (see DATA-09) | Guard — see DATA-09. |
| `DISC-06` | Duplicate suppliers have one definition | Guard — `src/lib/lead-dupe-guard.ts`. |
| `DISC-10` | Checkout decides what a marketplace is | Guard — the price read downgrades any marketplace-labelled |
| `OUT-05` | No draft into an existing thread may ignore what was already said | Guard — `src/lib/thread-context.ts`, |
| `OUT-06` | Internal notes never reach a supplier | Guard — `src/lib/internal-notes.ts` `stripInternalNotes` |
| `OUT-14` | Never offer to stop contacting a supplier | Guard — `CONCESSION_STRIPS` in `src/lib/email-style.ts`, run |
| `OUT-07` | Copy bans are applied at staging (see COMM-08) | Guard — `copy/staging-must-sanitize`. |
| `OUT-11` | A rejected draft is not redrafted | Guard — `src/lib/draft-suppression.ts` `isDraftSuppressed`, |
| `OUT-13` | Do-not-contact has two authors, and one gate | Guard — `src/lib/do-not-contact.ts` `isDoNotContact`, called |
| `OUT-15` | A discard has to say why, or it is a silent kill | Guard — `src/lib/draft-suppression.ts` |
| `ORG-01` | Every idempotency key is scoped to the organisation | Guard — `src/lib/org-isolation.ts` `orgScopedExternalId`, |
| `ORG-02` | Never fold leads from two clients into one draft | Guard — `foreignOrgRows`. |
| `ORG-03` | Shared natural keys carry the organisation in the database too | Guard — `orgs/upsert-conflict-key-must-include-org` plus the |
| `ORG-04` | An ambiguous inbound reply goes to triage, not to a guess | Guard — `soleOrgOwner`. |
| `ORG-08` | Membership in `organization_ids` tests the whole set, never a fixed slot | Guard — `orgs/no-fixed-index-org-membership`. |
| `ORG-09` | A supplier shared across clients never suppresses a client-owned supplier | Guard — `orgs/duplicate-guard-requires-exclusive-supplier`. |
| `ORG-10` | A supplier id is checked against its owners before it is stored | Guard — the shared resolver `scopedSupplierId` in |
| `ORG-11` | Unknown is not ambiguous | Guard — `soleReplyTarget` in `src/lib/org-isolation.ts`, |
| `SUP-01` | Suppliers are unique per client | Guard — `orgs/duplicate-guard-requires-exclusive-supplier` |
| `UI-01` | Never ship a native OS dropdown | Guard — `ui/no-native-select`. |
| `UI-09` | A one-click write needs a way back | Guard — `src/lib/call-undo.ts` `undoLastAttemptPatch`, surfaced |
| `UI-10` | A withheld value shows its reason where it renders | Guard — the withheld-price cells in |
| `SHIP-03` | A red build is silent, so build before you push | Guard — pre-push hook, on machines that ran `npm install`. |
| `SHIP-04` | Rules are checked before the build | Guard. |

## Audit (2)

| Rule | | Enforcement |
|---|---|---|
| `DATA-15` | Extraction records what it did not take | Audit — `agent-24-price-capture-reconcile`. Every inbound |
| `ORG-05` | The live data is audited every morning | Audit — the daily organisation-isolation audit. |

## Check owed (31)

| Rule | | Enforcement |
|---|---|---|
| `COMM-05` | Never speak as the human | Check owed — `comm/one-slack-sender`: a single send helper |
| `COMM-09` | Never announce as a bot in a crawler user agent | Check owed — `crawl/no-agent-identifying-user-agent`. |
| `AUTO-05` | Never touch: operator and org membership | Check owed — `orgs/no-operator-membership-writes`: no code |
| `AUTO-06` | Cold outbound is never auto-sent | Check owed — `outreach/no-send-outside-operator-action`, |
| `AUTO-08` | Call tasks belong to call operators only | Check owed — `assignment/call-owner-must-be-call-operator`. |
| `DATA-05` | Guessing a recipient is allowed; guessing content is not | Check owed — |
| `DATA-06` | Only a same-run verification counts as a confirmed email | Check owed — `contacts/confidence-derived-from-source`: |
| `DATA-07` | Density: bulk for solids, specific gravity for liquids | Check owed — `density/solids-require-bulk`. Partially held |
| `PRICING-01` | A shipping cost is a number or it is nothing | Check owed — `shipping/cost-must-be-numeric`. |
| `PRICING-02` | Delivery cost is per pack tier when pack size changes it | Check owed — `shipping/cost-per-tier`. |
| `PRICING-03` | Delivery-cost extraction is opt-in per client | Check owed — `shipping/extraction-org-opt-in`. |
| `PRICING-05` | A delivery cost is never fabricated | Check owed — `shipping/no-fabricated-costs`. |
| `PRICING-08` | A price row belongs to one lane and no writer may cross | Check owed — `pricing/quote-row-carries-its-lane`. |
| `PERS-02` | "Needs a human" is a display flag, never a queue exit | Check owed — `queues/flag-must-not-exit-queue`. |
| `PERS-03` | A zero-result pass is never "this market is empty" | Check owed — `discovery/zero-must-not-be-terminal`, over |
| `PERS-04` | Retry limits are a spend control, and must be named | Check owed — `retry/bound-must-be-declared`: a bounded |
| `PERS-05` | Never give up on a lead with no contact | Check owed — `outreach/no-terminal-drop-without-channel`. A |
| `DISC-02` | Aliases must reach the relevance filter too | Check owed — |
| `DISC-05` | A platform is never the supplier | Check owed — `discovery/platform-is-never-manufacturer`. |
| `DISC-07` | Same name, different grade, is not a duplicate | Check owed — `materials/never-merge-on-name-alone`. |
| `DISC-09` | A self-supplied material is not sourced | Check owed — |
| `OUT-02` | Marketplace storefronts get drafted, on a different channel | Check owed — `outreach/no-terminal-drop-without-channel`. |
| `OUT-04` | One email per supplier, one thread | Check owed — `outreach/one-thread-per-supplier`. |
| `OUT-08` | Supplier asks are staggered | Check owed — `outreach/asks-must-be-staged`. |
| `OUT-10` | A cancelled outreach must release its alias | Check owed — `outreach/cancel-must-release-alias`. |
| `OUT-12` | "denied" in Tenkara does not mean "do not contact" | Check owed — |
| `ORG-06` | Cross-client lookups are scoped at the query, not filtered after | Check owed — `orgs/name-lookup-must-scope-query`, plus an |
| `UI-02` | Everything lives on the client's own tabs | Check owed — `ui/no-global-review-route`. |
| `UI-06` | Flagged work needs a home | Check owed — `ui/flagged-set-must-have-a-surface`. See |
| `SHIP-02` | Never stage everything | Check owed — a pre-commit hook that refuses paths outside |
| `SHIP-07` | Deploy and schema move together | Check owed — `ship/migration-must-accompany-schema-read`. |

## Audit owed (6)

| Rule | | Enforcement |
|---|---|---|
| `DATA-08` | A dealbreaker grade is a hard specification | Audit owed — a daily check that a client with a stated |
| `PRICING-04` | Delivery-cost extraction is audited every run | Audit owed — daily shipping-capture health job, |
| `PERS-07` | A withheld price is a job, not an outcome | Audit owed — a daily count of withheld prices with no |
| `DISC-08` | A source's own paging must advance | Audit owed — a daily check that every paged source's cursor |
| `OUT-09` | Stalled conversations get chased | Audit owed — a daily report of conversations past their |
| `SHIP-08` | Weekly rules review | Audit owed — a weekly scheduled task that assembles the |

## Judgement (20)

| Rule | | Enforcement |
|---|---|---|
| `META-01` | Every rule and correction becomes code, permanently | Judgement. Process rule; partially visible via |
| `META-03` | Never route around a broken shared component | Judgement. Visible only because a workaround must be |
| `META-06` | Always verify current live status; never answer from memory | Judgement. |
| `META-07` | Read, do not pattern-match | Judgement. |
| `META-08` | Never filter your own diagnostic output | Judgement. |
| `COMM-01` | Keep replies short | Judgement. |
| `COMM-02` | Write for a non-developer | Judgement. |
| `COMM-03` | Claim only what a command proved | Judgement. This is the rule whose breach reads as "fake |
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
| `SHIP-05` | Confirm what production is actually serving | Judgement. This is the rule whose breach reads as "fake |

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
| `SHIP-06` | The deploy gate must not depend on one machine | None. A workflow file exists on disk but has never been |

## Retired (1)

| Rule | | Enforcement |
|---|---|---|
| `UI-08` | RETIRED: the CSV export sweep | Retired 2026-08-19. |
