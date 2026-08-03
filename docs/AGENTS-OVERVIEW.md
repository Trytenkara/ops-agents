# Control Room, Agents Overview

Developer reference for the agent fleet: how a run is triggered, what each agent reads and writes, the shared building blocks, and the invariants that must hold.

Operator-facing copy for each agent lives in `src/lib/agents-spec.ts` (rendered on `/how-it-works` and fed to the Ops assistant). Schedules live in the `agents` table of the OA Supabase project (`aiyzpjnvenfmurhyamge`). This doc covers the plumbing those two don't.

Last updated 2026-08-03 (post Tenkara email cutover).

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

---

## Shared stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14.2.15 (App Router), TypeScript |
| Runtime | Vercel Pro, Fluid Compute; `/api/cron` `maxDuration = 800`, `/api/agents/run/[slug]` 300 |
| Agent runtime | Embedded. Each agent calls `registerAgent({ slug, displayName, description, run(ctx) })` from `src/agents-runtime/registry.ts`; `src/agents-runtime/agents/index.ts` side-effect imports all 15 |
| OA database | Supabase `aiyzpjnvenfmurhyamge`, read/write via `createAdminClient()` (service role, server only) |
| Tenkara prod | Supabase `lciwjbtbadjpkooufsvx`, **read-only** via `tenkaraQuery()` / `withTenkaraClient()` (pg pool, max 1, transaction pooler, 12s client timeout, 3 attempts) |
| Email staging | Tenkara Super Agent API (`src/lib/tenkara.ts`). Missive (`src/lib/missive.ts`) is the retired path, still compiled |
| Inbound email | Signed webhook `POST /api/webhooks/tenkara` to `handleInboundReply()` in `src/lib/tenkara-inbound.ts` |
| LLM | Anthropic (`@anthropic-ai/sdk`): agent 03 scout (`web_search`), 05 price pull (`web_fetch` + `web_search`), 08/15 reply drafting, 12 client research, plus document/PO/quote extraction and the Ops assistant |
| Slack | `SLACK_BOT_TOKEN` via `src/lib/slack.ts`, alerts via `slack-alert.ts` / `safety-alerts.ts` |
| Storage | Supabase Storage (signed URLs, 7d TTL) |
| Trigger | External pinger to `GET /api/cron` (`Bearer $CRON_SECRET`); single agent: `?slug=<agent-slug>` |

### Email transport cutover

`coldOutboundEmailClient(agent)` in `src/lib/tenkara.ts` returns `"rod_app"` (Tenkara) unless `COLD_OUTBOUND_MISSIVE_AGENTS` names the agent (`all` / `true` / `1`, or a csv like `02,04`). Callers: agent 02 and `run-outreach.ts`.

`missivePollingEnabled()` returns true only when `ENABLE_MISSIVE_POLLING === "true"`. It is off, so the inbox-polling bodies of agents **08**, **13** and **15** no-op immediately; replies reach us through the Tenkara webhook instead. Agent 15 still does all of its scheduled outbound work (nudges, follow-ups); only its polling branch is dead. Agent 13 is a full no-op until it's rebuilt on Tenkara thread history.

### Shared building blocks

| Module | What it does |
|---|---|
| `src/lib/draft-staging.ts` | `stageDraft()`: creates the draft (Tenkara or Missive) without sending, runs the Agent 10 lint inline, writes `draft_references` with `qa_findings`, hard-blocks on a contact-guard hit. `mirrorDraftAssignee()` pushes the Control Room operator onto the Tenkara conversation. Used by 02 / 04 / 15 / inbound. |
| `src/agents-runtime/agents/outreach-qa/lint.ts` | `RULES` + `lintDraft(draft)`. The QA rule set, shared by the inline lint and the manual sweep. |
| `src/agents-runtime/agents/outreach/run-outreach.ts` | `runOutreachForSupplier()`: one email per supplier across a material pool, deterministic `SR-YYYYMMDD-NNNN` reference, stage + promote. |
| `src/agents-runtime/agents/data-enrichment/run-enrich.ts` | `enrichAndStageLead()`: run the contact waterfall, merge into the lead payload, promote to `enriched` or stamp a blocked reason. Always records the attempt. |
| `src/lib/contact-guard.ts` | Fabricated-contact detection and the per-brand allowlist. |
| `src/lib/operator-assignment.ts` | Sticky-random owner: a supplier always maps to the same operator within an org (FNV-1a hash into the org's pool), with out-of-office fallback. |
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
| `13,43 * * * *` | 08 email scanner (polling body no-ops; inbound is the webhook) |
| `20 * * * *` | 05 marketplace price re-check |
| `40 * * * *` | 12 client profile (stale-profile backstop; normally on demand) |
| `10 7 * * *` | 02 quote revalidation |
| `45 6 * * *` | 13 inbox context (no-op) |
| `0 14 * * *` | 07 escalation + nudge |
| `0 16 * * *` | 14 QA watchdog |
| `0 18 * * *` | fleet summary |
| `0 9 * * *` | 11 CSV push (held by `training_wheels`) |
| NULL | 10 outreach QA (inline in `stageDraft`) |

The offsets (`2/5`, `4/5`, `13,43`) are deliberate staggering so the heavy agents do not collide on the same minute.

---

## Agents

Slugs are `agent-NN-<name>`; source lives in `src/agents-runtime/agents/<dir>/`.

### 01 Ping · `ping/`
Liveness probe. Writes an `agent_runs` row, no business logic. The only agent exempt from the kill switch, and deliberately every-minute so an outage can't hide.

### 02 Quote Revalidation · `quote-revalidation/`
Sweeps Tenkara for expiring and expired quotes, groups by supplier (max 15 materials per email), and drafts one re-quote per (client × supplier): a reply inside the existing thread when there is one, otherwise a new conversation. QA-linted inline, assigned to an operator and mirrored to Tenkara, CSV uploaded, Slack summary posted. Debounced so a quote isn't re-drafted within 7 days. Active orgs only.

### 03 Lead Creator · `lead-creator/`
Stages `raw` leads only; enrichment and outreach are their own agents. Four sources: the Tenkara supplier graph, an Anthropic `web_search` scout (rotating 3-of-6 scoped passes so successive runs cover different ground), and signed webhook pulls from ImportYeti and SourceReady (25 materials each, results land out of band). Probes URLs, dedupes on supplier / canonical name / 90-day mirror, flags misspelled materials, caps at 300 leads per run, emits a sourcing CSV. Sources until a material has ~100 leads, then backs off; dry materials re-check weekly. Active and sourcing_only orgs.

### 04 Outreach · `outreach/` (+ `run-outreach.ts`, `drafter.ts`)
Sweeps `enriched` leads and composes ONE email per supplier: top 3 materials by confidence in the first email, the rest held for the reply loop. Every contact for that supplier rides one thread (primary on To, rest CC'd), reserved atomically so no address is emailed twice. Anthropic draft over a deterministic template fallback, staged through `stageDraft`, lead promoted to `ready_for_outreach`. Cap 5 drafts per run, real clients first. Holds back on spelling flags, still-enriching siblings, existing Tenkara relationships, excluded countries, do-not-contact, and equipment vendors; low-trust marketplace leads divert to `ready_for_approval`. Active orgs only.

### 05 Marketplace Price Re-check · `marketplace-validation/` (+ `price-recheck.ts`, `lead-price-pull.ts`)
Reads the real product page with Anthropic `web_fetch`, then repairs dead, wrong or gated links with `web_search` and re-fetches. Two passes: expiring Tenkara marketplace quotes (writes `marketplace_check_findings`, auto-dismissing unchanged prices) and marketplace leads (price, pack size, MOQ, lead time, tier ladder, checkout link written onto the lead, which is what the Agent Quotes tab renders). Checkout presence is the marketplace test. Never fabricates or back-calculates; foreign currency is converted to USD or held. Implausible 10x moves keep the price on file, operator-edited tiers are never overwritten, and 3 failures open a manual-pull case. Active and sourcing_only orgs, real clients first.

### 06 Data Enrichment · `data-enrichment/` (+ `enrich.ts`, `run-enrich.ts`)
First auto-seeds supplier and quote validation profiles (real clients first), then screens ImportYeti / SourceReady leads for product relevance and terminally drops mismatches. Contact waterfall per lead: multi-page own-domain website scrape, Tenkara supplier record, then Hunter.io, LeadMagic, ZoomInfo, GetProspect. Harvests the extra contacts Agent 04 will CC. Oldest-attempt-first, 25 leads per run inside a wall-clock deadline. Active and sourcing_only orgs.

### 07 Escalation + Nudge · `escalation/`
Opens a `cases` row for each lead untouched more than 14 days (assigned to the org's primary, or backup if out of office) and drops the lead as `escalated_to_case`; a lead already covered by an open case drops as a duplicate. Separately posts one Slack nudge per org covering drafts staged over 3 days, undrafted inbound replies, and leads stuck at `enriched`. Runs across every org regardless of sourcing status.

### 08 Email Scanner + Responder · `email-scanner/` (+ `reply-drafter.ts`)
Effectively webhook-driven. Tenkara pushes each inbound message to the signed webhook, which matches it to a thread by draft, then conversation, then known alternate address, then sender domain, raising a triage case when nothing matches. It detects bounces, auto-confirms marketplace signups, extracts prices from body and attachments into staged quotes (converting to USD), files supplier documents with parsed fields, updates the supplier profile, and stages a reply draft. The scheduled poll-the-inbox body skips itself while `ENABLE_MISSIVE_POLLING` is off.

### 09 Doc Refresh · deferred
Never built: no directory, no registry entry, no `agents` row. It survives as a placeholder in `agents-spec.ts` (slug `agent-09-doc-refresh`) so the numbering doesn't imply a missing agent. Document requests are handled inside Agent 15's qualification ask.

### 10 Outreach QA · `outreach-qa/`
Inline at draft creation for every 02 / 04 / 15 / inbound flow, writing `metadata.qa_findings`. Rules: leftover placeholders in body or subject, missing operator, empty body, misspelled material names, ghost-brand leaks, fabricated contact details. A fabricated-contact finding is a hard block: no draft is created, the record is marked blocked, and Slack is alerted. Everything else annotates without changing status.

### 11 Lead Scanner CSV Push · `lead-scanner-csv-push/` · paused (`training_wheels = true`)
Groups dropped and terminal leads per supplier, skips thin low-confidence batches, uploads a CSV with a 7-day signed link, posts to Slack, dedupes per supplier for 7 days, and re-alerts an export nobody acknowledges within 72 hours. There is no in-app acknowledgement step.

### 12 Client Profile · `client-profile/` (+ `src/lib/client-profile.ts`)
Combines the client's Tenkara data, the `client_settings` ops entered, `client_uploads` (notes and extracted file text), and open-web research into `client_profiles`: summary, highlights, sources, supplier rep sheet, derived `client_type`. Runs on demand (the Generate button), on settings save or document upload, and as an hourly backstop refreshing up to 3 profiles older than a week. An operator edit sets `manual_override` so auto-refresh skips it until an explicit Regenerate. OA writes only, never drafts email.

### 13 Inbox Context · `inbox-context/` · no-op
Built to precompute per-supplier email context from the Missive inbox for Agent 02's tone. Skips itself since the cutover. Rebuilding it on Tenkara thread history is outstanding work.

### 14 QA Watchdog · `qa-watchdog/`
Read-only integrity sweep: replies detected but never drafted, staged quotes missing a price or material, low-confidence or stale review items, marketplace findings pending over a week, agent failures in the last 24 hours. Posts a Slack digest only when there is something to report.

### 15 Reply Manager · `reply-manager/`
Owns the conversation after the first email. No reply: two nudges (roughly 4 and 8 days, production cadence) pulling in contacts not yet reached, then a calling-escalation case. Reply: classify and draft the right next message (answer the question, reframe a no-record reply as a fresh pricing ask, chase the missing number), always asking for EXW and tiered pricing plus that client's required qualification documents. Bounces are recorded and, past two in a day, raise a Slack alert and a case. A supplier who sends a web form or asks for something we don't have is handed to a human. A reply from a different address updates the contact. Stages only, never sends. Active orgs only.

### Fleet Summary · `fleet-summary/`
Daily digest of the last 24 hours of runs per agent, posted to Slack with a link to `/agents/health`.

---

## Pipeline view

```
Pinger (1 min) ──► GET /api/cron ──► fan-out: one invocation per due agent

Agent 03 (1 min)  ──► raw leads (graph + scout + ImportYeti + SourceReady) + sourcing CSV
      │
      ▼ Agent 06 (5 min): raw ──► enriched            (contact waterfall, relevance screen)
      ▼ Agent 04 (5 min): enriched ──► ready_for_outreach   (one draft per supplier, QA inline)
      ▼ 👤 operator reviews and sends from the Tenkara inbox
      ▼ supplier replies ──► POST /api/webhooks/tenkara ──► staged quotes + documents + reply draft
      ▼ Agent 15 (5 min): nudges silence, answers replies, chases the price ──► 👤 Send

Side-channels:
  - Agent 02 (daily 07:10): expiring-quote re-quote drafts
  - Agent 05 (hourly :20):  marketplace price re-check, findings + lead price/tier writes
  - Agent 07 (daily 14:00): >14d stale ──► case; Slack nudge on un-actioned work
  - Agent 12 (hourly :40):  stale client-profile backstop
  - Agent 14 (daily 16:00): integrity sweep ──► Slack digest
  - Fleet summary (daily 18:00), Agent 01 (1 min heartbeat)
```

The human gates are Promote/Drop on the Agent Supplier Leads tab, Send in the Tenkara inbox, and quote approval before the CSV export. Nothing else leaves the building.

---

## Platform Extraction (unlinked route)

`src/app/(app)/work/orgs/[slug]/extraction/page.tsx` still exists and still works, but it is **no longer in the org sub-nav** and is reachable only by direct URL; most of what it showed now lives on the Agent Quotes tab. It renders the quote board (extracted price lines with lead time, MOQ, payment terms, copy-to-Tenkara and CSV export) and the bench (vendor qualification against the client's Tenkara Sourcing Rules, per-supplier qualified/blocked, documents received with parsed fields). The capture path behind it is live regardless of the page: Agent 15 asks for the client's requested documents, the inbound webhook records attachments into `supplier_documents` (`src/lib/supplier-documents.ts`), and `src/lib/document-extract.ts` parses CoA lot/assay, cert validity and SDS revision into a promoted `expires_on`.

Current org sub-nav (`src/app/(app)/work/orgs/[slug]/layout.tsx`), in order: Overview `/`, Client Profile `/profile`, Platform Data `/materials` (matches `/suppliers`), Agent Supplier Leads `/leads`, Agent Quotes `/price-index`, Email Thread Tracker `/threads`, Cost Savings and Reports `/savings`. Other routes exist but are reached from cards and the cross-client Review queue rather than the sub-nav: `cases`, `approvals`, `inbound`, `outreach`, `pipeline`, `price-changes`, `quotes`, `revalidation`, `extraction`.

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
| `COLD_OUTBOUND_MISSIVE_AGENTS`, `ENABLE_MISSIVE_POLLING` | transport switches (both unset in prod) |
| `MISSIVE_API_TOKEN`, `MISSIVE_OUR_ADDRESSES`, `MISSIVE_REPLY_SCAN_TEAM_IDS`, `INBOX_CONTEXT_LABEL_ID`, `EMAIL_SCANNER_DRAFT_REPLIES` | retired Missive path (08, 13, and the 02/04 override) |
| `ANTHROPIC_API_KEY` | 03, 05, 08, 12, 13, 15, drafters, document/PO/quote extraction, Ops assistant |
| `SLACK_BOT_TOKEN`, `SLACK_ESCALATION_CHANNEL_ID` | 02, 07, 11, 14, fleet summary, health page |
| `SLACK_CONTACT_GUARD_CHANNEL_ID` | `draft-staging.ts` (fabricated-contact blocks) |
| `LEAD_SCANNER_SLACK_CHANNEL_ID` | 11 |
| `SAM_SLACK_DM_ID`, `OPS_ALERT_SLACK_USER_ID` | `safety-alerts.ts`, fleet summary, 15 |
| `HUNTER_API_KEY`, `LEADMAGIC_API_KEY`, `ZOOMINFO_CLIENT_ID`, `ZOOMINFO_CLIENT_SECRET`, `ZOOMINFO_API_BASE` | 06 contact waterfall |
| `LEAD_CREATOR_LOOKBACK_HOURS` | 03 (optional) |
| `OUTREACH_MAX_DRAFTS_PER_RUN` (default 5), `OUTREACH_FIRST_POOL_SIZE`, `OUTREACH_MAX_CONTACTS_PER_SUPPLIER`, `OUTREACH_MULTI_CONTACT` | 04, 06 (optional) |
| `PRICE_PULL_MODE`, `PRICE_PULL_DAILY_SOFT_LIMIT`, `MARKETPLACE_RECHECK_MODEL` | 05 (optional) |
| `FOLLOWUP_MINUTES`, `OUTREACH_COMPILE_WAIT_MINUTES`, `CALLING_ESCALATE_AFTER_MINUTES`, `FAST_TRACK_ORG_IDS`, `MOTHERLODE_ORG_IDS` | per-org timing and tiering |
| `COMPLETENESS_FOLLOWUP_ENABLED` | `quote-completeness.ts` |
| `ONLY_ORG`, `QR_ONLY_ORG` | legacy env scoping, superseded by `orgs.sourcing_status` |
| `SUPABASE_DEV_URL`, `SUPABASE_DEV_SERVICE_KEY` | `campaign-suppliers.ts` (dev project) |
