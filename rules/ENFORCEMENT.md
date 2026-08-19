# Enforcement ledger

Generated from the Enforcement line of every rule by
`npm run gen:enforcement`. Do not edit by hand: the rule files are the
source of truth and this is only a view of them.

94 rules. 37 are actually enforced, 32 owe a check or a job,
19 are human judgement that nothing could ever check.

| Status | Meaning | Count |
|---|---|---|
| **Guard** | A shared module or build check makes it impossible. | 36 |
| **Audit** | A scheduled job reports the break after the fact. | 1 |
| **Check owed** | A build check is possible and is not built yet. | 26 |
| **Audit owed** | No build check can see it; a scheduled job can. Not built. | 6 |
| **Judgement** | Nothing mechanical can ever verify it. Human, by design. | 19 |
| **Cross-reference** | Restates a rule enforced elsewhere. | 3 |
| **None** | Outside this repository. Cannot be checked here. | 2 |
| **Retired** | No longer applies. | 1 |

Anything "owed" is also listed in `OUTSTANDING.md`; the build refuses
otherwise, so a gap cannot go quiet.

## Guard (36)

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
| `AUTO-10` | Near-duplicate supplier names reach one operator | Guard. `src/lib/operator-assignment.ts` `mergeSimilarNameKeys` in `getOrgLeadIndex`. |
| `DATA-01` | Never fabricate, approximate or infer a price | Guard — `src/lib/price-publish.ts` `publishablePrice` / |
| `DATA-02` | A foreign price is published only through one conversion | Guard — `fx/no-direct-convertToUsd`. |
| `DATA-04` | Agents may never invent a contact detail in an outgoing body | Guard — `src/lib/contact-guard.ts`, |
| `DATA-09` | Aliases never add a qualifier the input lacked | Guard — `GRADE_WORDS` in `src/lib/material-aliases.ts`. |
| `PRICING-01` | Shipping costs are numeric, never static text | Guard — `src/lib/browserbase-pull.ts` `captureShippingCost()` enforces numeric extraction; `src/lib/shipping-estimation.ts` validates that estimates scale by weight/volume. |
| `PRICING-02` | Shipping is per-tier when pack size affects cost | Guard — `src/lib/shipping-estimation.ts` `estimatePerTierShipping()` validates that estimates are proportional to weight/volume deltas. |
| `PRICING-03` | Shipping extraction is opt-in per org | Guard — `src/agents-runtime/agents/browserbase-escalation/index.ts` wraps shipping capture in try/catch and never propagates its failure. Shipping failures are logged in `shipping_cost_failed_reason` for audit. |
| `PRICING-05` | Shipping is never fabricated or hallucinated | Guard — `src/lib/browserbase-pull.ts` `extractShippingCost()` returns null if extraction fails; `captureShippingCost()` never fabricates a value. |
| `PERS-01` | Only a structural verdict is terminal | Guard — `src/lib/retry-verdict.ts` `classifyFailure`. Owed: |
| `PERS-06` | No hidden caps on a worklist | Guard for the accidental cut — `src/lib/supabase-paging.ts` |
| `DISC-01` | Search the trade's name, not ours | Guard — shared resolver, threaded into all three sources. |
| `DISC-03` | Aliases never re-specify (see DATA-09) | Guard — see DATA-09. |
| `DISC-06` | Duplicate suppliers have one definition | Guard — `src/lib/lead-dupe-guard.ts`. |
| `OUT-05` | No draft into an existing thread may ignore what was already said | Guard — `src/lib/thread-context.ts`, |
| `OUT-06` | Internal notes never reach a supplier | Guard — `src/lib/internal-notes.ts` `stripInternalNotes` |
| `OUT-07` | Copy bans are applied at staging (see COMM-08) | Guard — `copy/staging-must-sanitize`. |
| `OUT-11` | A rejected draft is not redrafted | Guard — `src/lib/draft-suppression.ts` `isDraftSuppressed`, |
| `OUT-13` | Do-not-contact has two authors, and one gate | Guard — `src/lib/do-not-contact.ts` `isDoNotContact`, called |
| `ORG-01` | Every idempotency key is scoped to the organisation | Guard — `src/lib/org-isolation.ts` `orgScopedExternalId`, |
| `ORG-02` | Never fold leads from two clients into one draft | Guard — `foreignOrgRows`. |
| `ORG-03` | Shared natural keys carry the organisation in the database too | Guard — `orgs/upsert-conflict-key-must-include-org` plus the |
| `ORG-04` | An ambiguous inbound reply goes to triage, not to a guess | Guard — `soleOrgOwner`. |
| `ORG-08` | Membership in `organization_ids` tests the whole set, never a fixed slot | Guard — `orgs/no-fixed-index-org-membership`. |
| `ORG-09` | A supplier shared across clients never suppresses a client-owned supplier | Guard — `orgs/duplicate-guard-requires-exclusive-supplier`. |
| `UI-01` | Never ship a native OS dropdown | Guard — `ui/no-native-select`. |
| `SHIP-03` | A red build is silent, so build before you push | Guard — pre-push hook, on machines that ran `npm install`. |
| `SHIP-04` | Rules are checked before the build | Guard. |

## Audit (1)

| Rule | | Enforcement |
|---|---|---|
| `ORG-05` | The live data is audited every morning | Audit — the daily organisation-isolation audit. |

## Check owed (26)

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
| `PRICING-04` | Shipping extraction is audited per run | Audit owed — daily health job checking `(leads where |
| `PERS-07` | A withheld price is a job, not an outcome | Audit owed — a daily count of withheld prices with no |
| `DISC-08` | A source's own paging must advance | Audit owed — a daily check that every paged source's cursor |
| `OUT-09` | Stalled conversations get chased | Audit owed — a daily report of conversations past their |
| `SHIP-08` | Weekly rules review | Audit owed — a weekly scheduled task that assembles the |

## Judgement (19)

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
