# Control Room, Agents Overview

Developer reference for the agent fleet: how a run is triggered, what each agent reads and writes, the shared building blocks, and the invariants that must hold.

Operator-facing copy for each agent lives in `src/lib/agents-spec.ts` (rendered on `/how-it-works` and fed to the Ops assistant). Schedules live in the `agents` table of the OA Supabase project (`aiyzpjnvenfmurhyamge`). This doc covers the plumbing those two don't.

Last updated 2026-08-06 (Missive removed, agents 09 and 16 added, agent 08 retired to the webhook).

---

## The model (read this first)

**The clock is external.** An always-on pinger (Supabase `pg_cron` job in the OA project) hits `GET /api/cron` every minute with `Authorization: Bearer $CRON_SECRET`. The `crons` entry in `vercel.json` is a daily `0 0 * * *` vestige kept as a fallback; Vercel cron proved unreliable for this project, so do not treat it as the schedule.

**Dispatch fans out.** `/api/cron` with no query param is the dispatcher: it selects every `runtime='embedded'` agent with a non-null `schedule_cron`, works out which are due (`cron-parser` against `schedule_cron` / `schedule_tz` and `last_run_at`), then fetches `/api/cron?slug=<agent>` once per due agent and awaits them all. Each agent therefore gets its own invocation and its own budget (`maxDuration = 800`, Pro + Fluid Compute), so a heavy agent can no longer time out the light ones.

**Gotcha:** because the dispatcher re-enters through the same `?slug=` path, `agent_runs.trigger_source` reads `manual` even for scheduled runs. It is not evidence a human pressed anything.

**Three gates before an agent touches an org:**
1. `agents.training_wheels` (the fleet kill switch). Set true, the agent is skipped with reason `training_wheels`. Only `agent-01-ping` is exempt. Toggled from `/agents/health`.
2. `orgs.sourcing_status` (`src/lib/org-status.ts`): `active` (full pipeline), `sourcing_only` (discovery and enrichment only, outreach/replies/re-quote held), `off` (skip entirely). New orgs default to `off`.
3. Per-org tier interval (`src/lib/org-tier.ts`, `agent_org_timing`): the pinger fires every minute globally, so each agent skips an org whose minimum interval hasn't elapsed. Tiers are `testing` (fast-track, `FAST_TRACK_ORG_IDS`), `motherlode` (`MOTHERLODE_ORG_IDS`), and `normal`.

Where a capped queue serves both, real clients (`orgs.is_internal = false`) drain before internal test orgs.

**The lead pipeline is a chain of independently scheduled agents**, each isolated:
- **03 Lead Creator** stages `raw` leads from four discovery sources.
- **06 Enrichment** takes `raw` to `enriched`, or leaves it `raw` with a blocked reason.
- **04 Outreach** takes `enriched` to `ready_for_outreach` and stages one draft per supplier.
- **15 Reply Manager** owns the thread after that first email; inbound arrives by webhook, not polling.

**10 Outreach QA is the only agent that is not scheduled** (`schedule_cron` NULL). It runs inline inside `stageDraft` every time 02 / 04 / 15 / the inbound webhook create a draft.

### Standing safety invariants

1. **No email is ever sent automatically.** Agents stage drafts in the client's Tenkara inbox; an operator clicks Send.
2. **No writes to Tenkara prod.** `src/lib/tenkara-readonly.ts` refuses to build a pool unless the `TENKARA_READONLY_DATABASE_URL` username starts with `mcp_readonly.`, and fires `alertTenkaraWriteAttempt()` if it doesn't. Role-level enforcement lives DB-side.
3. **All writes land in the OA Supabase project.** Collected quotes leave as a CSV that ops bulk-uploads.
4. **Agents never fabricate.** `src/lib/contact-guard.ts` deterministically detects contact info in an outgoing body and hard-blocks any draft stating a value that isn't on the human-curated allowlist (a prompt instruction alone is not steadfast). Prices follow the same rule: unreadable means flagged with the reason, never estimated or back-calculated.
5. **The sender stays with the operator.** No agent sets a from address.

### Operator assignment is per-org

Each org picks how suppliers get an owner (`orgs.assignment_mode`, editable from the org's assignment panel):

| Mode | Behaviour |
|---|---|
| `manual` | Only explicit claims own anything; the auto spread is off. **Default for new orgs.** |
| `auto_new` | A claim wins; auto fills every unclaimed supplier. Existing orgs were backfilled to this. |
| `auto_all` | Auto owns every supplier in scope. Claims are ignored while it is set, but never deleted, so switching back to `auto_new` restores them. |

Beyond the mode, each membership row carries **what that person does on this client**: `user_org_assignments.operator_type` (`call` or `email`) and `user_org_assignments.lanes` (any of `marketplace` / `aggregator` / `direct`). Both are per-(user, org), which is what enforces "can be both, but never for the same client" without a rule to check. `poolForWork()` narrows the pool to the right type and lane before the hash runs, and each filter falls back to the unnarrowed pool rather than returning nobody, so a client with no named call operator still has its calls land on a person. The old org-wide Primary/Backup pair is gone (table `org_default_operators` dropped in `0107`).

Under `auto_all` an ops lead can still override: only a claim stamped **after** `orgs.assignment_auto_all_at` wins, since older claims are exactly what "reassign all" was asked to redo. Scope is `orgs.assignment_supplier_types` (`marketplace` / `aggregator` / `direct`), and `user_org_assignments.auto_assignable` takes one person out of the auto loop without removing their org membership.

Two traps worth knowing. Narrowing the scope used to drop every supplier of the removed kind to "Unassigned" (Sierra lost 231 aggregators that way), so the derived owner is now frozen into `supplier_assignment` before the change lands, and the whole change fails if that pinning fails. And the hash key is not always the supplier id: it falls back to the contact email only when the value is actually email-shaped, because `supplier_contact_email` sometimes holds a prose channel note ("via IndiaMART inquiry") which collapsed 62 unrelated suppliers onto one operator.

---

## Shared stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14.2.15 (App Router), TypeScript |
| Runtime | Vercel Pro, Fluid Compute; `/api/cron` `maxDuration = 800`, `/api/agents/run/[slug]` 300 |
| Agent runtime | Embedded. Each agent calls `registerAgent({ slug, displayName, description, run(ctx) })` from `src/agents-runtime/registry.ts`; `src/agents-runtime/agents/index.ts` side-effect imports all 16. An agent may declare `lanes: N` (agent 06 does) and the dispatcher then fans out one invocation per lane |
| OA database | Supabase `aiyzpjnvenfmurhyamge`, read/write via `createAdminClient()` (service role, server only) |
| Tenkara prod | Supabase `lciwjbtbadjpkooufsvx`, **read-only** via `tenkaraQuery()` / `withTenkaraClient()` (pg pool, max 1, transaction pooler, 12s client timeout, 3 attempts) |
| Email staging | Tenkara Super Agent API (`src/lib/tenkara.ts`). Tenkara-only: `stageDraft` hardcodes `email_client: "rod_app"` |
| Inbound email | Signed webhook `POST /api/webhooks/tenkara` to `handleInboundReply()` in `src/lib/tenkara-inbound.ts` |
| LLM | Anthropic (`@anthropic-ai/sdk`): agent 03 scout (`web_search`), 05 price pull (`web_fetch` + `web_search`), 08/15 reply drafting, 12 client research, plus document/PO/quote extraction and the Ops assistant |
| Slack | `SLACK_BOT_TOKEN` via `src/lib/slack.ts`, alerts via `slack-alert.ts` / `safety-alerts.ts` |
| Storage | Supabase Storage (signed URLs, 7d TTL) |
| Trigger | External pinger to `GET /api/cron` (`Bearer $CRON_SECRET`); single agent: `?slug=<agent-slug>` |

### Email transport

Tenkara is the only transport. Missive was deleted, not merely switched off: there is no `src/lib/missive.ts`, no `coldOutboundEmailClient()`, no `missivePollingEnabled()`, and zero reads of `COLD_OUTBOUND_MISSIVE_AGENTS`, `ENABLE_MISSIVE_POLLING`, `MISSIVE_API_TOKEN`, `MISSIVE_OUR_ADDRESSES`, `MISSIVE_REPLY_SCAN_TEAM_IDS`, `INBOX_CONTEXT_LABEL_ID` or `EMAIL_SCANNER_DRAFT_REPLIES` anywhere in `src/`. Do not reintroduce a transport switch; there is nothing to switch to.

What survives is inert legacy-row handling, not a code path: `src/lib/types.ts` still types `email_client` as `"missive" | "rod_app"`, `src/lib/draft-detail.ts` renders a `mail.missiveapp.com` link for pre-cutover rows, `src/lib/outreach-tracker.ts` excludes legacy Missive drafts, and `qa-watchdog` reads `metadata.missive_draft_link`.

Inbound is the signed webhook and nothing else. Agent 08's scheduled body was deleted along with its directory; `handleInboundReply()` in `src/lib/tenkara-inbound.ts` **is** agent 08, and it stamps its runs against the retired `agents` row. Its supporting modules moved up to `src/lib/reply-drafter.ts`.

### Shared building blocks

| Module | What it does |
|---|---|
| `src/lib/draft-staging.ts` | `stageDraft()`: creates the Tenkara draft without sending (`email_client` is hardcoded `"rod_app"`), runs the Agent 10 lint inline, writes `draft_references` with `qa_findings`, hard-blocks on a contact-guard hit. `mirrorDraftAssignee()` pushes the Control Room operator onto the Tenkara conversation. Used by 02 / 04 / 15 / inbound. |
| `src/agents-runtime/agents/outreach-qa/lint.ts` | `RULES` + `lintDraft(draft)`. The QA rule set, shared by the inline lint and the manual sweep. |
| `src/agents-runtime/agents/outreach/run-outreach.ts` | `runOutreachForSupplier()`: one email per supplier across a material pool, deterministic `SR-YYYYMMDD-NNNN` reference, stage + promote. |
| `src/agents-runtime/agents/data-enrichment/run-enrich.ts` | `enrichAndStageLead()`: run the contact waterfall, merge into the lead payload, promote to `enriched` or stamp a blocked reason. Always records the attempt. |
| `src/lib/contact-guard.ts` | Fabricated-contact detection and the per-brand allowlist. |
| `src/lib/operator-assignment.ts` | Sticky owner by **rendezvous hashing**: every operator in the pool is scored `hash(supplierKey:operatorId)` and the max wins, so adding or removing an operator moves only ~1/N of suppliers. Explicitly not `hash % pool.length`, which re-derived nearly every owner on a pool change. The hash is FNV-1a plus a murmur3 avalanche finalizer; raw FNV-1a over near-identical keys left one operator ~25% over quota. Pool excludes out-of-office and deactivated users. |
| `src/lib/reassign-owners.ts`, `src/lib/freeze-assignments.ts` | `reassignIneligibleOwners()` moves a departing operator's whole book (claims, drafts including the Tenkara conversation assignee, active leads). `freezeDerivedOwners()` pins currently-derived owners into `supplier_assignment` *before* a scope narrows, so suppliers don't silently fall to Unassigned. |
| `src/lib/org-status.ts`, `src/lib/org-tier.ts`, `src/lib/agent-timing.ts` | The three org gates plus the follow-up / escalation / compile-wait clocks. |
| `src/lib/safety-alerts.ts` | DMs Sam on run failures and invariant breaks. Error alerts debounce hourly per agent; `from_field` and Tenkara-write attempts bypass the debounce. |

---

## Schedule (live values from `agents.schedule_cron`, America/New_York)

| Cron | Agent |
|---|---|
| `*/1 * * * *` | 01 ping, 03 lead creator |
| `2/5 * * * *` | 06 enrichment |
| `4/5 * * * *` | 15 reply manager |
| `*/5 * * * *` | 04 outreach |
| `20 * * * *` | 05 marketplace price re-check |
| `40 * * * *` | 12 client profile (stale-profile backstop; normally on demand) |
| `50 * * * *` | 09 document retrieval (`schedule_tz` is `Asia/Manila`, the only agent not on `America/New_York`; irrelevant for an hourly cron, but unintentional) |
| `5 */6 * * *` | 16 FX refresh |
| `10 7 * * *` | 02 quote revalidation |
| `45 6 * * *` | 13 inbox context |
| `0 14 * * *` | 07 escalation + nudge |
| `0 16 * * *` | 14 QA watchdog |
| `0 18 * * *` | fleet summary |
| `0 9 * * *` | 11 CSV push (held by `training_wheels`) |
| NULL | 10 outreach QA (inline in `stageDraft`) |
| NULL | 08 email scanner, `status = 'disabled'` (retired to the webhook; the row survives only as an FK anchor) |

The offsets (`2/5`, `4/5`) are deliberate staggering so the heavy agents do not collide on the same minute.

There are 17 rows in `agents` but only 16 registered agents: `agent-08-email-scanner` has no code behind it any more. `draft_references` and `agent_runs` FK to its id and the inbound webhook still stamps runs against it, so the row is kept deliberately (`supabase/migrations/0079_retire_agent_08_schedule.sql`).

---

## Agents

Slugs are `agent-NN-<name>`; source lives in `src/agents-runtime/agents/<dir>/`.

### 01 Ping · `ping/`
Liveness probe. Writes an `agent_runs` row, no business logic. The only agent exempt from the kill switch, and deliberately every-minute so an outage can't hide.

### 02 Quote Revalidation · `quote-revalidation/`
Sweeps Tenkara for expiring and expired quotes, groups by supplier (max 15 materials per email), and drafts one re-quote per (client × supplier): a reply inside the existing thread when there is one, otherwise a new conversation. QA-linted inline, assigned to an operator and mirrored to Tenkara, CSV uploaded, Slack summary posted. Debounced so a quote isn't re-drafted within 7 days. Active orgs only.

### 03 Lead Creator · `lead-creator/`
Stages `raw` leads only; enrichment and outreach are their own agents. Four sources: the Tenkara supplier graph, an Anthropic `web_search` scout (rotating 3-of-6 scoped passes so successive runs cover different ground), an in-process ImportYeti US-customs pull, and a signed webhook pull from SourceReady (25 materials each per run). ImportYeti stages its leads inline during the run; SourceReady results still land out of band. Probes URLs, dedupes on supplier / canonical name / 90-day mirror, flags misspelled materials, caps at 300 leads per run, emits a sourcing CSV. Sources until a material has ~100 leads, then backs off; dry materials re-check weekly. Active and sourcing_only orgs.

**ImportYeti runs in-process** (`lib/importyeti-client.ts` + `lead-creator/importyeti.ts`), not via a webhook to an external agent. An ImportYeti 5xx leaves the page cursor unadvanced so the same page is retried next run rather than silently skipped. SourceReady still fires a signed webhook because it exposes no HTTP API, only MCP tools.

**Paging runs off an explicit cursor**, `agent_state` key `discovery_page:<source>:<materialId>`, advancing exactly one page per fire and wrapping to page 1 after 3 dry pages. Page number used to be inferred from the ingested lead count, which pinned every material to page 1 forever: Cetearyl Alcohol sat at 54 ingested of a 100-supplier page 1 while page 2 held 92 suppliers we had never seen.

**Scout output survives our own timeout.** Streamed text is accumulated, and when the scout's abort timer fires with a partial JSON buffer the salvage path parses what arrived rather than discarding the pass. Genuine API errors and pre-JSON timeouts still fail normally.

**Duplicate material flagging** runs on a 6-hourly throttle across every mapped org's full material set (not the recency window, and not only orgs due for sourcing), writing `material_merge_flags` and posting to `#control-room-feedback`. Materials with an `applied` merge flag are dropped from the run so re-scouting cannot rebuild the duplicate. Same-name-different-grade pairs are intentional specs and are not merge candidates.

### 04 Outreach · `outreach/` (+ `run-outreach.ts`, `drafter.ts`)
Sweeps `enriched` leads and composes ONE email per supplier: top 3 materials by confidence in the first email, the rest held for the reply loop. Every contact for that supplier rides one thread (primary on To, rest CC'd), reserved atomically so no address is emailed twice. Anthropic draft over a deterministic template fallback, staged through `stageDraft`, lead promoted to `ready_for_outreach`. Material names resolve from Tenkara first and only then from the lead's stored `material_name`: one `material_id` was rendering as both "Monoethanolamine" and "Monoethanolamine (MEA)", splitting every name-keyed surface. Cap 5 drafts per run, real clients first. Holds back on spelling flags, still-enriching siblings, existing Tenkara relationships, excluded countries, do-not-contact, and equipment vendors; low-trust marketplace leads divert to `ready_for_approval`. Active orgs only.

### 05 Marketplace Price Re-check · `marketplace-validation/` (+ `price-recheck.ts`, `lead-price-pull.ts`)
Reads the real product page with Anthropic `web_fetch`, then repairs dead, wrong or gated links with `web_search` and re-fetches. **Three cohorts plus a split path**, sharing one 700s wall-clock budget (raised from 270s, which starved the re-check cohort) at concurrency 4:

| Cohort | Cap |
|---|---|
| Expiring Tenkara marketplace quotes (writes `marketplace_check_findings`, auto-dismissing unchanged prices) | 25 |
| Lead first pull, no price yet | 20 |
| Lead re-check, already priced and due | 50 |
| Aggregator index-page expansion | 8 sellers per page |

First pulls and seller enumeration use `claude-sonnet-5`; re-checks use the cheaper `MARKETPLACE_RECHECK_MODEL` (default `claude-haiku-4-5`). Default `FULL` mode re-verifies every priced lead **daily**; the AIMD volatility ladder and per-host priors only apply in `adaptive` mode.

**It never gives up.** There is no terminal failure state: a failed read stays `pending` forever and `flagged` is display-only. The old `needs_manual_pull` park was unwound in migration `0089` (888 leads). Retry backoff is 1/1/3/7/14/30 days. An escalation case opens on the **first** `login_required` or `link_broken`, and only after 3 attempts for `needs_review`; infra failures (5xx, no JSON, out of tokens) neither count an attempt nor escalate. A failed re-check preserves the last good price and defers a day.

**Escalations close themselves.** When a price finally lands, open `marketplace_price_pull` cases for that lead (or supplier + material) are auto-resolved with the price in the note. Before this, 41% of open cases were already done.

Never fabricates or back-calculates. Foreign currency is converted to USD or held, with a token sniff overriding a wrong or blank currency label and a quarantine for a USD label on a domestic-currency host. Implausible 10x moves keep the prior price on file, and operator-edited tiers are never overwritten. Active and sourcing_only orgs, real clients first.

### 06 Data Enrichment · `data-enrichment/` (+ `enrich.ts`, `run-enrich.ts`)
Runs in **2 parallel lanes** (`lanes: 2`), so the dispatcher fires two invocations per tick, `?slug=...&lane=N`. Lane 2 takes a lane-numbered lock instead of the agent reservation, and only lane 1 advances the tier clock. `MAX_LEADS_PER_RUN = 25` is **per lane**, so 50 per tick, concurrency 5 within a lane.

Lane 1 only, before any lead work: seeds supplier and quote validation profiles (real clients first), refreshes moved marketplace quote prices, fills blank profile fields from leads / `staged_quotes.payment_terms` / Tenkara suppliers, then runs the paid web fill (real clients only, cap 12, `claude-sonnet-5` with `web_fetch` + `web_search`). Fields a site doesn't print are stamped `not_published`; a supplier whose site was **never reached** is not finalized, it banks an attempt and retries on a 7-day cooldown up to 3 times. Every underlying select is paged, because an unpaged PostgREST select silently caps at 1000 rows and re-did the same first 1000 every cycle. The seed cap counts writes *touched*, not inserts, so a fully-profiled org can't issue one UPDATE per supplier forever.

Then screens ImportYeti / SourceReady leads for product relevance and terminally drops mismatches (`drop_reason = 'provider_product_mismatch'`).

**Claiming is not oldest-first.** The `claim_enrichment_leads` RPC splits the cap: one fifth (5 of 25) is reserved for previously-attempted leads ordered oldest-attempt-first, the rest goes to never-attempted leads ordered by confidence, and a shortfall in either spills to the other. Picks and stamps in one statement, `FOR UPDATE SKIP LOCKED`. Without the reserved slice, re-queued leads starved behind the fresh ones forever.

**Contact waterfall per lead**, in order:
1. Seed from the scout payload (or a SourceReady unlock).
2. **Per-domain memo, read before the crawl** (30-day TTL, keyed on hostname). A cached hit still visits the site, but caps it at one page. A cached miss inside its backoff (1/3/7/14/30 days) suppresses **paid** lookups only; the free crawl always runs.
3. Free crawl, up to 7 pages, including `/impressum`, `/kontakt`, `/team`, `/leadership`. Decodes Cloudflare-obfuscated addresses and "(at)/(dot)" forms. A 401/403/429 is recorded as `blocked`, not as "no contact". Harvests named POCs off about/team/impressum pages.
4. **LLM contact read** (`claude-haiku-4-5`), only when the crawl found no email, no phone and no people but pages did load. It copies what is on the page, it does not infer, and the output is re-validated. This is the "read, don't pattern-match" fallback; do not replace it with another regex.
5. Tenkara supplier record (`shipping_email` / `billing_email`).
6. Paid providers, Hunter → LeadMagic → ZoomInfo → GetProspect, each gated on: **real clients only** (`orgs.is_internal = false`), not memo-suppressed, and not tripped by the per-run circuit breaker (a 429/402 trips that provider for the rest of the run; an auth failure deliberately does not). Hunter additionally latches a process-lifetime quota flag. These are **not** own-domain gated: the aggregator-host gate was tried and reverted, paid lookups run against marketplace storefront hosts too.
7. **Guessed-pattern fallback**, own corporate domain only, never an aggregator host: with a name in hand but no email, generate `first.last@`, `flast@`, `firstl@`, `first_last@`, `first@`; the first becomes the primary address and the rest ride as CC'd `additional_contacts`. Everything is labelled `source: "pattern_guess"`, `contact_confidence: "guessed"` so an operator can see it is a best guess before sending. A guessed address is never cached as a hit.

CC harvesting runs after a primary is found. Every paid call is journaled into `agent_run_events` and priced in the cost tracker; quota and auth outcomes surface in the run log.

**Parked leads get re-queued.** `requeue_parked_contact_leads` (cap 8 per run, 168h cooldown, lane 1) flips `enriched`-but-uncontactable leads back to `raw`. Its predicate requires a genuinely email-shaped address, so "via website contact form" counts as no contact and the lead comes back around. It deliberately does not clear the attempt stamp, which is why the retry slice above exists.

**Dealbreaker screening is advisory.** Each lead is assessed against the client's dealbreaker grades and cert requirements; the verdict (`meets` / `unmet` / `unknown`) is stored on the payload and drives sort order in the UI. It does not block, drop, or change `completeness_score`. A prose spec too vague to judge is reported unjudgeable rather than guessed at.

Active and sourcing_only orgs.

### 07 Escalation + Nudge · `escalation/`
Opens a `cases` row for each lead untouched more than 14 days (assigned to the supplier's owning operator, skipping anyone out of office) and drops the lead as `escalated_to_case`; a lead already covered by an open case drops as a duplicate. Separately posts one Slack nudge per org covering drafts staged over 3 days, undrafted inbound replies, and leads stuck at `enriched`. Runs across every org regardless of sourcing status.

### 08 Email Scanner + Responder · `src/lib/tenkara-inbound.ts` (+ `src/lib/reply-drafter.ts`)
Not a scheduled agent and no longer a directory: the `email-scanner/` folder and its registry entry were deleted, and the `agents` row is unscheduled and `disabled`. The webhook is the agent, and it is where reply classification and drafting actually happen (not in Agent 15).

The route multiplexes four event types: `message.received` into `handleInboundReply()`, `verification_link.detected` into the marketplace-confirm handler (links only, deliberately not routed through the supplier-reply flow), `conversation.agent_created` acked, and `draft.sent` / `draft.discarded` flipping `draft_references.status` and `reviewed_at`. That `reviewed_at` on a `draft.sent` is the sent timestamp Agent 15's nudge clock reads.

**The match chain is six steps, not four**: plus-tag (`metadata.reply_tag`, minted per inquiry, the strongest signal) → `in_reply_to_draft_id` → conversation id → operator-attached alias → sender **domain** (non-generic domains only) → exact full sender address (allowed on generic domains). The last two only match when every candidate resolves to a single supplier and material. Which path matched is recorded on `reply_detected` for audit. Nothing matched raises a triage case, a review-only clarification draft and a Slack alert; an inbox that maps to no org dead-letters as `needs_org_assignment` instead.

Then, in order: bounce detection (**every** bounce alerts Slack and opens a `manual_outreach` case, there is no two-per-day threshold), marketplace signup auto-confirm, a marketplace→direct lead split, aggregator-relay escalation, price extraction from body and attachments into staged quotes (normalized to USD, lowest per-unit line mirrored onto the lead), document filing, supplier profile update, referral staging when a supplier points us elsewhere, an advisory ships-to-us annotation, and finally the reply draft (thread capped at `MAX_REPLY_TURNS = 8`, after which the thread goes `stale`).

**Supplier identity is recovered, not assumed.** From turn two the newest ref on a thread has no `lead_id`, so the handler falls back to the thread's originating ref, and the staged-quote merge is keyed on the normalized supplier *name* rather than `supplier_id` (only 1 of 34 staged rows carried an id).

**CC lists are replayed.** Every reply unions `metadata.cc_contacts` across every draft row on the thread, minus the To address; before that each agent reply silently dropped the rest of the supplier's team.

A supplier who cannot ship to the US is **kept**: the drafter is explicitly told this is not a dead end and asks for EXW at works plus the nearest port.

### 09 Document Retrieval · `document-retrieval/`
Built 2026-08-04; the doc-refresh placeholder it replaced was never built. Slug is `agent-09-document-retrieval`. Collects qualification documents (SDS/CoA/TDS/certs) already published on supplier and product pages, so we ask suppliers for fewer of them. Candidate URLs come from three sources: `quote_profiles.source_url`, active `leads_in_flight` (`payload.source_url` and `payload.supplier_website`), and `marketplace_check_findings.source_url`. Scans through `retrieveDocumentsFromUrl()` (`src/lib/document-retrieve.ts`), stores the files, and upserts a `document_page_scans` row per page **including misses**, with a note saying why nothing was stored. Then calls `syncDocRequirementsMet()` per org to tick requirements the stored documents satisfy. Never emails. `MAX_PAGES_PER_RUN = 40`, `RUN_BUDGET_MS = 600_000`, `RESCAN_AFTER_DAYS = 60`, dedupe on a sha1 page hash, real clients first. Active and sourcing_only orgs.

Expect a low hit rate: recent runs store 0-2 documents per 40 pages with 5-11 pages refused outright (403/429). That is the shape of the work, not a fault.

**Note:** `src/lib/agents-spec.ts` still describes agent 09 as `deferred` under the dead slug `agent-09-doc-refresh`, so `/how-it-works` and the Ops assistant are both wrong about it.

### 10 Outreach QA · `outreach-qa/`
Inline at draft creation for every 02 / 04 / 15 / inbound flow, writing `metadata.qa_findings`. Eight rules (`outreach-qa/lint.ts`): `placeholders_in_body`, `placeholders_in_subject`, `missing_operator`, `empty_body` (under 50 chars), `fabricated_contact_info`, `grade_ask_widened`, `likely_misspelling`, `ghost_brand_leak`.

**Two of them hard-block**, not one: `BLOCKING_CODES` in `draft-staging.ts` is `fabricated_contact_info` and `grade_ask_widened`. On a hit no provider draft is created, the `draft_references` row is written `status: "blocked"`, and Slack is alerted. Everything else annotates without changing status, so error severity is not the same thing as a block: `ghost_brand_leak`, `empty_body` and both placeholder rules are errors that still ship a draft.

`grade_ask_widened` (the dealbreaker-grade rule) arms only when `metadata.required_grade` is set, and fires on copy inviting the supplier to propose a different grade. Asking for the dealbreaker grade is the point; offering an alternative undoes it.

The contact guard strips our own `SR-YYYYMMDD-NNNN` reference before scanning: it was reading the reference as a phone number and had blocked 124 legitimate drafts.

The unscheduled sweep body still exists as a backstop (60-minute grace, 7-day window, 100 drafts per run) and never changes status.

### 11 Lead Scanner CSV Push · `lead-scanner-csv-push/` · paused (`training_wheels = true`)
Groups dropped and terminal leads per supplier, skips thin low-confidence batches, uploads a CSV with a 7-day signed link, posts to Slack, dedupes per supplier for 7 days, and re-alerts an export nobody acknowledges within 72 hours. There is no in-app acknowledgement step.

### 12 Client Profile · `client-profile/` (+ `src/lib/client-profile.ts`)
Three jobs, in this order, and the profile research is only the last of them.

**1. Client settings mirror (every run, every org, no LLM).** `syncAllClientSettings()` copies each client's Tenkara settings into `client_tenkara_settings`: shipping addresses (primary broken out into company / address line / apartment / city / state / zip / country), billing and samples addresses, unit of measurement, country exclusions, qualification requirements. It runs ahead of and independently of the research sweep on purpose. The reply path reads it, which is how a reply can state the ship-to.

**2. Requirements re-check.** When an org's `requirements_hash` moves, `recheckOrgLeads()` re-judges that org's existing leads against the new requirements. Pure recompute over evidence already on the payload: no LLM, no web, no contact credits, nothing dropped or re-staged, advisory fields only. Sized to what an hourly agent can actually finish (45s budget, bails under 5s remaining, up to 5000 leads and a 60s deadline per org), real clients before internal and worked orgs before `off` ones. The fingerprint is written **only after a complete error-free pass**, so a truncated pass resumes next cycle instead of silently skipping leads.

**3. Client profile.** Combines the client's Tenkara data, the `client_settings` ops entered, `client_uploads` (notes and extracted file text), and open-web research into `client_profiles`: summary, highlights, sources, supplier rep sheet, derived `client_type`. Runs on demand (the Generate button), on settings save or document upload, and as an hourly backstop refreshing up to 3 profiles older than a week. An operator edit sets `manual_override` so auto-refresh skips it until an explicit Regenerate.

OA writes only, never drafts email.

### 13 Inbox Context · `inbox-context/`
Rebuilt on Tenkara thread history (it was a no-op after the cutover). Precomputes per-supplier email context for Agent 02's tone: reads `draft_references` where `email_client = 'rod_app'` over a 90-day lookback, paged, walks each conversation through `getTenkaraConversationDetails()`, and upserts `supplier_email_context` keyed on the recipient address (not `supplier_id`, which agents 04/08/15 leave null). Thread states are `stale` / `they_replied` / `awaiting_their_reply`. Limits: `MAX_CONVERSATIONS = 400`, `WALK_BUDGET_MS` 8.5 min, `MAX_LLM_SUMMARIES = 40` on `claude-haiku-4-5`, `STALE_DAYS = 21`. Reads Tenkara serially on purpose. Runs `partial` most days because the cap bites; a best-first ranking (known traffic, then real clients, then newest) makes sure what gets dropped is the least interesting.

Guardrails, all of which exist because it previously invented supplier conversations: a thread with no messages (staged but never sent) writes **no row** rather than a `they_replied` guess, direction comes from Tenkara's `is_outbound` before any sender heuristic, and `blocked:` sentinel thread ids are skipped instead of being sent to Tenkara as conversation ids.

### 14 QA Watchdog · `qa-watchdog/`
Read-only integrity sweep: replies detected but never drafted, staged quotes missing a price or material, low-confidence or stale review items, marketplace findings pending over a week, agent failures in the last 24 hours. Posts a Slack digest only when there is something to report.

### 15 Reply Manager · `reply-manager/`
Three jobs, in this order: **reconcile the threads, then chase the silence — both before a supplier ever replies and after they replied and went quiet.** Reply classification and drafting belong to the webhook, not here. Reconcile failure only degrades the run to `partial`.

**Thread reconcile** (`thread-reconcile.ts`) catches inbound messages no webhook ever delivered. It polls every tracked Tenkara thread on an age-based cadence (hot under 21 days hourly, warm 12-hourly, cold weekly, and 15 minutes after a thread just yielded something), reading at half Tenkara's allowed rate with a 200s budget and 120 threads per run. Per thread it follows merge hops, takes the **newest unseen message per sender**, and replays it. Older messages from the same sender are superseded, except that any carrying attachments are still replayed `extractOnly` so the files are not lost, oldest first, so the newest message's `reply_detected` stamp is the one that sticks. Messages are claimed in the `inbound_message_ledger` before replay, and a claim abandoned for 20 minutes can be atomically taken over by the next run. A thread that is unreadable or only half-replayed does not get its next-check time advanced, so it stays at the front of the queue. The run reports backlog and oldest-due age. Note this sweep is **not** org-status gated.

**No-reply nudges**: two, on day 2 and day 4 in production, pulling in contacts not yet reached (reserved atomically so nobody is emailed twice). Caps of 50 drafts and 50 escalations per run. A nudge is suppressed when the thread is terminal, when the org is not `active`, when the draft was never reviewed, **when anyone on the thread has replied** (checked across every ref on the thread, because the inbound handler stamps `reply_detected` on the newest ref while the Agent 04 row stays null forever), and **when the previous nudge is still sitting unsent in the outbox**. Sequence position counts only nudges that were actually acted on, and nudge #2 can never land closer than 4 days after nudge #1 truly went out. Both of those gates exist because the two nudges once stacked ~5 minutes apart on 142 threads.

**Stalled-conversation nudges** (`stalled-followup.ts`): the sweep above covers only pre-reply silence, so before this existed a supplier who answered once and then went quiet got no further touch at all — not another email, and not the day-5 call, which `supersededByReply` also suppresses. This sweep owns the other half. It measures silence from **our last outbound message**, not from the inquiry, so the clock restarts every time the conversation moves, and it opens on the same 2d/4d rhythm as the no-reply nudges before widening to 7d, 14d, then 30d. The sequence **never exhausts**: `stalledFollowupGapMs()` clamps the index to the last entry, so past 30d it repeats monthly forever. An unanswered email is never abandoned, only chased more slowly.

The two sweeps partition on whether the thread has ever had a reply, so a supplier can never be chased by both. A nudge is suppressed when the org is not `active`, when one of our own drafts is still sitting unsent in the outbox, when the supplier's last message is newer than ours (we owe *them* a reply), and on a genuine ending only: `closed_declined`, `finalized`, `price_captured`, or `metadata.conversation_complete` — a model-judged flag the reply drafter sets alongside `engaged` when our own reply leaves the supplier nothing to answer. Note `flow_status: "stale"` is deliberately **not** an ending here: that is our own `MAX_REPLY_TURNS` cap firing on a busy thread, not a supplier saying goodbye. The contact address is read from anywhere on the thread, because our reply drafts do not all carry `supplier_contact_email` and the newest message often is not the one that knows where to write. Cap of 50 drafts per run. `scripts/dryrun-stalled-followups.mts` runs the real gate logic against prod and prints what would be drafted, staging nothing.

**Call tasks** (`call-tasks.ts`): calling is scheduled work in the cadence, not a last resort. Stage 1 lands on day 1 and fires whether or not the supplier replied (the intro call, made while the first email is still fresh); stage 2 lands on day 5 and only for threads with no reply at all. Every offset is measured from the day the sourcing inquiry was actually sent (`draft_references.reviewed_at`), so a nudge sent late cannot drag the phone work with it, and the delays are per-org via `callTaskDelaysMs()` in `src/lib/agent-timing.ts` (prod 1d/5d, compressed orgs via `CALL_TASK_MINUTES`). Each task is a `cases` row of type `calling_escalation` carrying `metadata.call_stage` and a `call_brief` (contact + phone, the supplier's calling window resolved to their timezone, why we are calling, and the asks). One open call case per supplier at a time; `outreachAllowed()` gates them, so `sourcing_only` orgs raise none.

The Overview scoreboard splits the `cases` table between an "Open cases" card (everything else) and a "Calls owed" card; the Cases page and the Call Tracker filter the same way, so a call is never counted twice.

The worklist is the per-client **Call Tracker** tab (`/work/orgs/[slug]/calls`), filterable by operator and by call stage, rows collapsed to one line and expanded on click. Alongside the frozen brief each row reads `supplier_email_context` **live at render time** (Agent 13's per-supplier summary, open ask and thread state) so a brief written on day 1 does not describe a stale thread on day 5. Closing a row either de-escalates the supplier back into the email sequence (with the operator's notes and per-call success flags) or drops them with a required reason.

Stages only, never sends.

### 16 FX Refresh · `fx-refresh/`
Restates published USD prices from the stored native-currency price on `leads_in_flight` and `staged_quotes` when rates move (`refreshFxPrices()` in `src/lib/fx-refresh.ts`). Arithmetic only: no scraping, no LLM, no supplier contact, OA writes only. Every 6 hours at :05. Unlike the rest of the fleet its `agents` row was created directly in the database, so there is no seeding migration in `supabase/migrations/`.

### Fleet Summary · `fleet-summary/`
Daily digest of the last 24 hours of runs per agent, posted to Slack with a link to `/agents/health`.

---

## Marketplace, aggregator, direct

"Checkout presence is the marketplace test" is now only the first branch of a three-way decision, and the rule set lives in two libs rather than in agent 05:

| Kind | Test | `site_type` |
|---|---|---|
| Marketplace | Checkout present | `M` / `MS` |
| Aggregator | Many suppliers, no checkout | `A` |
| Direct | One company, no checkout | `N` |

Two curated host lists carry the "no checkout" cases that a page read gets wrong (`src/lib/marketplace-hosts.ts`), and agent 05 short-circuits on them **before any fetch**:

- `DIRECTORY_HOSTS` (Knowde, ThomasNet, ZoomInfo, LinkedIn, Tridge, SpecialChem, …) are lead sources and RFQ relays. The platform is never the supplier.
- `DIRECT_NO_CHECKOUT_HOSTS` (Azelis, DKSH Discover, ITW Reagents, Nutri Avenue, …) are one company's own quote-desk catalogue. A real supplier with no published price still goes to outreach.

The 22 aggregators in `src/lib/aggregator-hosts.ts` **keep** their printed numbers, stamped `price_trust: "low"`. The curated list beats the model's read, so a wrong "no checkout" verdict cannot blank an aggregator price. `src/lib/lead-market.ts` is the single classifier every surface reads.

**The aggregator split.** An index, category or search page is never a supplier. Agent 05 asks for the seller roster whenever the name or URL *could* be an index page, deliberately erring toward asking, and then either retires the umbrella row (`drop_reason = 'aggregator_index_page'`) and stages each seller, or, when the row is a real company sitting on a category page, re-points it at its own listing and stages the others. Cloned-listing rings (shared listing slug plus 3 or more near-identical names) are screened out first. Staged sellers get `confidence_score 0.35` and deliberately **no** `supplier_website`: a storefront URL is not the seller's site, and enrichment would otherwise domain-search the platform and return the platform's own staff.

**A seller who replies from their own address becomes a second, direct lead** rather than a flip: the listing row keeps the price index, the new row carries the contact, and the listing row deliberately never gets the email so the two tracks cannot both cold-email. Replies through the platform's relay address are not split; they raise a `manual_outreach` case. Inquiry-form replies route by plus-tag.

## Price data

Every price now carries where it came from and what moved it.

Leads and staged quotes store the native figures alongside the USD ones (`native_price`, `native_currency`, `fx_rate`, `fx_rate_at`). USD listings are **explicitly stamped** `native_currency: "USD"`, `fx_rate: 1`, because a null has to keep meaning "unknown" (a legacy pre-capture row) or the delta split fabricates an attribution.

`src/lib/price-delta.ts` decomposes a move exactly: `usd1-usd0 = n1*(f1-f0) + (n1-n0)*f0`. The FX component is valued at the current quantity and the cross-term is charged to the currency side. Agent 05 persists the split per headline **and per rung** (`price_change_source`, `supplier_delta_usd`, `currency_delta_usd`, `supplier_price_usd`), and `price_changed_at` moves only for a seller-driven change, never for FX. Change detection compares native-to-native when the currencies match, falling back to USD only when they don't. Provenance is `price_source` ∈ `marketplace_scrape | fx_refresh | supplier_quote | operator`. The `price_provenance` view exposes all of this as columns instead of a jsonb dig; nothing in `src/` reads it yet, it is a query surface.

`src/lib/price-qa.ts` is the shared read-time QA layer, and it never edits. It refuses to assume 1.0 g/mL for a liquid, and when a $/kg does rest on a density it says so (`converted_via_density`, naming the density kind and rank; `warn` when the density is unattributed). Densities are ranked `operator > listing > document > web > unattributed`, and a solid needs **bulk** fill density, never crystal density. A per-unit price is never derived from a packing line.

## Pipeline view

```
Pinger (1 min) ──► GET /api/cron ──► fan-out: one invocation per due agent

Agent 03 (1 min)  ──► raw leads (graph + scout + ImportYeti + SourceReady) + sourcing CSV
      │
      ▼ Agent 06 (5 min, 2 lanes): raw ──► enriched   (contact waterfall, relevance + dealbreaker screen)
      ▼ Agent 04 (5 min): enriched ──► ready_for_outreach   (one draft per supplier, QA inline)
      ▼ 👤 operator reviews and sends from the Tenkara inbox
      ▼ supplier replies ──► POST /api/webhooks/tenkara ──► staged quotes + documents + reply draft
      ▼ Agent 15 (5 min): reconciles threads the webhook missed, nudges silence (day 2, day 4; stalled threads 2d/4d/7d/14d then monthly, forever) ──► 👤 Send
      ▼ Agent 15 also raises the calls: day 1 intro, day 5 on silence ──► 👤 Call Tracker tab

Side-channels:
  - Agent 02 (daily 07:10): expiring-quote re-quote drafts
  - Agent 05 (hourly :20):  marketplace price re-check, findings + lead price/tier writes
  - Agent 07 (daily 14:00): >14d stale ──► case; Slack nudge on un-actioned work
  - Agent 09 (hourly :50):  documents published on supplier/product pages ──► supplier_documents
  - Agent 12 (hourly :40):  client settings mirror, requirements re-check, profile backstop
  - Agent 13 (daily 06:45): per-supplier thread context for Agent 02's tone and the Call Tracker's "From the inbox" panel
  - Agent 14 (daily 16:00): integrity sweep ──► Slack digest
  - Agent 16 (every 6h :05): restate USD prices when FX moves
  - Fleet summary (daily 18:00), Agent 01 (1 min heartbeat)

There are two inbound paths, not one: the webhook, and Agent 15's reconcile sweep for messages the webhook never delivered.
```

The human gates are Promote/Drop on the Agent Supplier Leads tab, Send in the Tenkara inbox, working the calls on the Call Tracker tab, and quote approval before the CSV export. Nothing else leaves the building.

---

## Platform Extraction (unlinked route)

`src/app/(app)/work/orgs/[slug]/extraction/page.tsx` still exists and still works, but it is **no longer in the org sub-nav** and is reachable only by direct URL; most of what it showed now lives on the Agent Quotes tab. It renders the quote board (extracted price lines with lead time, MOQ, payment terms, copy-to-Tenkara and CSV export) and the bench (vendor qualification against the client's Tenkara Sourcing Rules, per-supplier qualified/blocked, documents received with parsed fields). The capture path behind it is live regardless of the page, and documents now also render on the Agent Supplier Leads tab, the quote card, and both CSV exports.

### Documents

Two writers feed `supplier_documents` (`src/lib/supplier-documents.ts`): the inbound webhook (email attachments) and **Agent 09** (documents already published on supplier and product pages, including the pages Agent 05 repaired).

**Bytes are stored**, not just links, in a private `supplier-docs` bucket on a content-addressed path, because a supplier can silently replace a file at the same URL and captured links die fast (3 TDS links died within four days). Upload failure degrades to metadata plus the source URL rather than losing the row, and a pre-existing row with no stored copy gets its bytes attached on a later pass rather than being skipped as a duplicate. Downloads go through a 60s signed URL.

**Supplier-issued vs reference copy.** An email attachment is always supplier-issued: a supplier attaching a document to their own reply is issuing it, even when the PDF was authored by their upstream manufacturer. Web-retrieved documents are classified by host: same registrable root or a storefront CDN counts as issued, a short list of reference databases (ChemicalBook, Sigma-Aldrich, Fisher, PubChem, …) does not, and anything unknown counts.

**Requirement ticking is fill-only and evidence-bound.** Whether a document is required comes from the client's Tenkara rules, with the local `preorder_*_required` column as fallback only (it was false on all 939 live rows). A tick requires **both** a supplier match and a material match: unattributed documents were ticking CoA on supplier-less quotes, and 22 of 46 ticks were for a material with no document. Only `false → true` is automated; un-ticking stays manual.

Extraction (`src/lib/document-extract.ts`) reads PDF, txt, csv, xlsx/xlsm, docx and images; legacy `.xls`/`.doc` are deliberately out. An SDS or TDS `expires_on` equal to the document's own revision date is dropped, since a revision date is not an expiry. Operators can correct parsed fields through a validated allowlist per document type; corrections are stored in `extracted_overrides` and never overwrite `extracted`, so a re-parse cannot destroy a correction. Every consumer must read through `mergedDocFields()`.

Current org sub-nav (`src/app/(app)/work/orgs/[slug]/layout.tsx`), in order: Overview `/`, Client Profile `/profile`, Platform Data `/materials` (matches `/suppliers`), Agent Supplier Leads `/leads`, Agent Quotes `/price-index`, Email Thread Tracker `/threads`, Cost Savings and Reports `/savings`. Other routes exist but are reached from cards and the cross-client Review queue rather than the sub-nav: `cases`, `approvals`, `inbound`, `outreach`, `pipeline`, `price-changes`, `quotes`, `revalidation`, `extraction`.

Outside the per-org tree, `/work/review` is the cross-client queue (`drafts`, `leads`, `marketplace`, `marketplace-outreach`, `pricing-pipeline`, `staged-quotes`), `/work/drafts/[id]` is the single-draft review page every queue links into, `/work/price-pulse` is the fleet-wide price view, and `/work/exports` holds the generated CSVs.

---

## Manual trigger and inspection

```bash
# One agent, straight through the cron path:
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://ops-agents-vu4o.vercel.app/api/cron?slug=agent-03-lead-creator"
```

Operators can also trigger from the UI: `POST /api/agents/run/[slug]`, session-authed, admin/monitor plus ops_lead/ops_operator for the client-safe slugs (03, 04, 06).

```sql
-- last 10 runs across the fleet
select a.slug, ar.status, ar.summary, ar.items_processed, ar.run_finished_at
from agent_runs ar join agents a on a.id = ar.agent_id
order by ar.run_finished_at desc nulls last limit 10;

-- events for a run
select level, step, message, data from agent_run_events where run_id = '<RUN_ID>' order by at asc;

-- what the dispatcher sees
select slug, schedule_cron, schedule_tz, training_wheels, status, last_run_at from agents order by slug;
```

## Env vars

| Var | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | all (OA database) |
| `NEXT_PUBLIC_APP_URL` | Slack deep links, operator invites, login |
| `CRON_SECRET` | `/api/cron` (dispatcher and single-agent path) |
| `RELAY_API_KEY` | `/api/relay/*` |
| `TENKARA_READONLY_DATABASE_URL` | 02, 03, 05, 06, 12 (read-only pool; username must start with `mcp_readonly.`) |
| `TENKARA_API_TOKEN` | Tenkara Super Agent client + attachments (02, 04, 15, inbound) |
| `TENKARA_WEBHOOK_SECRET` | `/api/webhooks/tenkara` HMAC-SHA256 verification |
| `ANTHROPIC_API_KEY` | 03, 05, 06, 09, 12, 13, 15, the inbound webhook, drafters, document/PO/quote extraction, Ops assistant |
| `SLACK_BOT_TOKEN`, `SLACK_OPS_CHANNEL_ID` | Every Slack post in the repo — one channel, no per-agent targets |
| `HUNTER_API_KEY`, `LEADMAGIC_API_KEY`, `ZOOMINFO_CLIENT_ID`, `ZOOMINFO_CLIENT_SECRET`, `ZOOMINFO_API_BASE`, `GETPROSPECT_API_KEY` | 06 contact waterfall |
| `HUNTER_MAX_EMAILS_PER_DOMAIN` (default 3) | 06 (Hunter cost knob) |
| `IMPORTYETI_API_KEY` | 03 (ImportYeti discovery runs in-process; inert without it) |
| `SOURCEREADY_WEBHOOK_URL`, `SOURCEREADY_WEBHOOK_SECRET` | 03 (SourceReady discovery is inert without the pair) |
| `SOURCEREADY_UNLOCK_CONTACTS` | 03 (paid contact unlock, default **off**) |
| `SOURCEREADY_MAX_MATERIALS_PER_RUN`, `SOURCEREADY_PAGE_SIZE`, `IMPORTYETI_MAX_MATERIALS_PER_RUN`, `IMPORTYETI_PAGE_SIZE` | 03 (optional) |
| `DISCOVERY_MIN_NEW_PER_PAGE`, `DISCOVERY_MAX_DRY_PAGES` | 03 page cursor (optional) |
| `DISCOVERY_MIN_NEW_PER_CYCLE`, `DISCOVERY_DRY_STREAK_LIMIT`, `DISCOVERY_SATURATED_BACKOFF_HOURS` | 03 saturation backoff (optional) |
| `LEAD_CREATOR_MIN_LEADS_PER_MATERIAL` (default 100), `LEAD_CREATOR_RESCOUT_BACKOFF_HOURS`, `LEAD_CREATOR_LOOKBACK_HOURS` | 03 (optional) |
| `OUTREACH_MAX_DRAFTS_PER_RUN` (default 5), `OUTREACH_FIRST_POOL_SIZE`, `OUTREACH_MAX_CONTACTS_PER_SUPPLIER`, `OUTREACH_MULTI_CONTACT` | 04, 06 (optional) |
| `PRICE_PULL_MODE`, `PRICE_PULL_DAILY_SOFT_LIMIT`, `MARKETPLACE_RECHECK_MODEL` | 05 (optional) |
| `FOLLOWUP_MINUTES`, `OUTREACH_COMPILE_WAIT_MINUTES`, `CALL_TASK_MINUTES`, `FAST_TRACK_ORG_IDS`, `MOTHERLODE_ORG_IDS` | per-org timing and tiering |
| `COMPLETENESS_FOLLOWUP_ENABLED` | `quote-completeness.ts` |
| `ONLY_ORG`, `QR_ONLY_ORG` | legacy env scoping, superseded by `orgs.sourcing_status` |
| `SUPABASE_DEV_URL`, `SUPABASE_DEV_SERVICE_KEY` | `campaign-suppliers.ts` (dev project) |
