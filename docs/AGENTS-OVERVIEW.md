# Tackle Box — Agents Overview

Reference doc for the agent fleet: what each agent does, what it reads/writes, its safety constraints, and how the pieces fit together.

Source of truth for the in-app descriptions: `public.agents` table (OA project `aiyzpjnvenfmurhyamge`) and `src/lib/agents-spec.ts`. Last updated 2026-05-29 for the flow re-architecture.

---

## The model (read this first)

**Each agent runs in its own isolated invocation.** `/api/cron` (the 5-min Vercel cron) figures out which agents are due, then dispatches **each one to its own `/api/cron?slug=<agent>` invocation** (its own 300s budget) in parallel — rather than running them all together in one function. This is deliberate: previously a heavy agent could blow the shared 300s budget and time-out the lightweight ones (even the heartbeat) with it.

The **lead pipeline is a chain of independently-scheduled agents**, each isolated:
- **03 Lead Creator** (every 2h) — scouts suppliers for new materials → stages `raw` leads + a sourcing CSV.
- **06 Enrichment** (every 30m) — `raw` → `enriched` via persistent contact discovery.
- **04 Outreach** (every 30m) — `enriched` → drafts a Missive draft → `ready_for_outreach`.

Only **10 Outreach QA** is truly *not* scheduled — it runs **inline** inside the shared draft-staging pipeline whenever 02/03(→04)/08 create a draft. (`schedule_cron` NULL.)

**Surfacing is hybrid:** the top-level Review Queue (`/work/review`) is a per-org **nudge dashboard** ("Org X: 5 new leads, 3 to send") that deep-links into **per-org tabs** (Expiries / Leads / Price Changes / Outreach / Inbound / Cases / Approvals) where the detail and actions live. Cross-org detail is still reachable under the "All …" tabs.

### Standing safety invariants (must hold across every agent)
1. **No emails are ever sent automatically.** The Missive client only stages drafts; an operator clicks Send in Missive.
2. **No writes to Tenkara prod.** Only the read-only client is wired.
3. **All writes land in the OA Supabase project.**
4. **`from_field` stays empty on every draft.** The operator picks the sender.

---

## Shared stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14.2.15 (App Router), TypeScript |
| Runtime | Vercel (300s function maxDuration) |
| Agent runtime | Embedded — each agent `registerAgent({ slug, displayName, description, run(ctx) })`; `/api/cron` dispatches each due agent to its own `?slug=` invocation (isolated 300s budget) |
| OA database | Supabase `aiyzpjnvenfmurhyamge` — read/write via `createAdminClient()` |
| Tenkara prod | Supabase `lciwjbtbadjpkooufsvx` — **read-only** via `tenkaraQuery()` |
| Email staging | Missive REST (`src/lib/missive.ts`) — drafts only; refuses `send`/`from_field` at compile + runtime |
| LLM | Anthropic (`@anthropic-ai/sdk`) — Agent 03 scout (web_search), Agent 08 reply drafter, the in-app Ops assistant |
| Slack | `SLACK_BOT_TOKEN` |
| Storage | Supabase Storage (signed URLs, 7d TTL) |
| Triggers | Vercel cron → `GET /api/cron` (auth `Bearer $CRON_SECRET`); single-agent: `?slug=<agent-slug>` |

### Shared building-block functions
- `src/agents-runtime/agents/outreach-qa/lint.ts` → `lintDraft(draft)` — the QA rules.
- `src/lib/draft-staging.ts` → `stageDraft(...)` — Missive create + inline `lintDraft` + `draft_references` insert. Used by 02/04/08.
- `src/agents-runtime/agents/outreach/run-outreach.ts` → `runOutreachForLead(...)` — compose + stage + promote.
- `src/agents-runtime/agents/data-enrichment/run-enrich.ts` → `enrichAndStageLead(...)` — enrich + promote/block.

---

## Schedule (America/New_York)

| Time | Agents |
|---|---|
| every 5 min | 01 heartbeat (`*/5`) |
| 07:00 | 02 expiries, 05 price changes |
| 07:00–21:00, every 2h | 03 lead creator (scout) |
| every 30 min (:05, :35) | 06 enrichment |
| every 30 min (:20, :50) | 04 outreach |
| every 30 min | 08 inbound email scan + reply draft |
| 14:00 | 07 escalation + nudge |
| every hour (:00) | 12 client profile (backstop; normally on-demand) |
| 18:00 | fleet summary |
| — (inline) | 10 QA (runs inside draft staging) |
| — (paused) | 09 doc refresh, 11 CSV push |

---

## Agents

### Agent 01 — Heartbeat · `*/5 * * * *`
Infrastructure liveness probe; writes an `agent_runs` row. No business logic. (Kept frequent deliberately — a twice-daily heartbeat would hide outages.)

### Agent 02 — Quote Revalidation · daily 07:00
`quote-revalidation/index.ts`. Sweeps Tenkara for expiring/expired quotes, classifies each client (active vs ghost), drafts **one email per (client × supplier)** with its own revalidation copy, runs the **QA lint inline** (`qa_findings` on each `draft_references` row), uploads a CSV, posts a Slack summary. **Debounces** so a given quote isn't re-drafted within 7 days (important now that it runs daily, not weekly). Reads Tenkara; writes Missive drafts + `draft_references` + Storage + Slack.

### Agent 03 — Lead Creator (scout) · every 2h, 07:00–21:00
`lead-creator/index.ts`. Scouts suppliers for newly-added Tenkara materials and stages them as `raw` leads — it does **not** enrich or draft (06 and 04 do that on their own schedules).
1. **Scout:** graph candidates + web discovery (Anthropic `web_search`, streamed) → `leads_in_flight @ stage=raw`. Known-major-producer pass + marketplace seller drill-in; confidence High/Med/Low = 0.80/0.60/0.35.
2. **CSV:** upload a sourcing CSV of the run's new leads **plus the saved quotes we already have** for those materials (context rows, `kind=existing_quote`). Signed URL on run metadata; also surfaced on the per-org Leads tab.
Reads Tenkara + OA; writes `leads_in_flight`. Budget-guarded so a big batch of new materials still fits one invocation.

### Agent 04 — Outreach · every 30m (:20, :50)
`outreach/index.ts` + `run-outreach.ts` + `drafter.ts`. Sweeps `enriched` leads, composes a deterministic (no-LLM) outreach email, stages it through `stageDraft` (QA inline), promotes the lead to `ready_for_outreach`. Filters: valid email, org classify (active/ghost), prior-relationship skip, dedup. Cap 5/run. Runs in its own isolated invocation. (`run-outreach.ts`/`stageDraft` are also reused by 02/08.)

### Agent 05 — Marketplace Validation / Price Changes · daily 07:00
`marketplace-validation/index.ts`. Re-checks marketplace prices on expiring quotes and writes `marketplace_check_findings` (status `pending_review`). Review-only — ops approves/dismisses on the per-org **Price Changes** tab and applies changes on Tenkara manually. Never drafts email.

### Agent 06 — Data Enrichment · every 30m (:05, :35)
`data-enrichment/index.ts` + `enrich.ts` + `run-enrich.ts`. Sweeps `raw` leads and promotes to `enriched`, or leaves `raw` with `enrichment_blocked_reason`. **Persistent multi-page contact discovery**: fetches the homepage, follows Contact/About/Sales links + common paths, parses emails/phones (incl. footers), captures a quote/contact-form URL; only stamps `all_contact_channels_invalid` after trying ≥3 pages. Runs in its own isolated invocation with a wall-clock deadline; leftovers roll to the next run.

### Agent 07 — Escalation + Nudge · daily 14:00
`escalation/index.ts`. Two jobs: (1) opens a `cases` row for leads stale >14d (assigned to the org's primary/backup operator), and (2) posts a **Slack nudge** per org about items pending >3d — staged drafts not sent, reply drafts not sent, leads stuck at `enriched`. The nudge writes nothing; the per-org UI computes its counts live.

### Agent 08 — Email Scanner + Responder · every 30 min
`email-scanner/index.ts` + `reply-drafter.ts`. Scans the Missive team inbox; matches inbound by **sender email** (not thread id). Stamps `reply_detected` on `draft_references` and `supplier_reply` on the lead, then **composes a contextual reply** (Anthropic Sonnet) and stages it via `stageDraft` (deduped on `metadata.reply_draft`). Reply drafts surface on the per-org **Inbound** tab. Never sends. (Kept frequent so replies don't wait ~24h.)

### Agent 09 — Doc Refresh · paused
Not built. A future draft-producer (refresh out-of-date specs/COAs).

### Agent 10 — Outreach QA · inline (not scheduled)
`outreach-qa/lint.ts` (rules) + `index.ts` (backstop sweep). Runs **inline at draft creation** inside `stageDraft` for every 02/03/08 flow, writing `metadata.qa_findings`. Rules: placeholders in body/subject (error), missing operator (warn), empty body (error), ghost-brand leak (error). Does not change draft status.

### Agent 11 — Lead Scanner CSV Push · paused (`training_wheels=true`)
`lead-scanner-csv-push/index.ts`. Per-supplier CSV of dropped/terminal leads to Andrew (Tenkara eng). Currently paused.

### Agent 12 — Client Profile · on-demand + hourly backstop
`client-profile/index.ts` + `src/lib/client-profile.ts`. **Researches** a client and writes a summarized `client_profiles` row per org. `generateClientProfile()` gathers four inputs — (1) the client's **Tenkara data** (quotes, suppliers, materials, contacts — read-only, best-effort), (2) any **`client_settings`** entries ops typed, (3) **uploaded info** (`client_uploads`: notes + extracted file text), (4) **open-web research** via Anthropic `web_search` (Sonnet) — then summarizes into `summary` + `highlights` + `sources` + a **supplier rep sheet** (`rep_sheet`), and derives `client_type` (active/ghost/skip/prospect) from settings + activity. The rep sheet answers the questions suppliers typically ask about a client — years in business, products, address, end use, volume needed, order timing, intended use (resale/distribution vs manufacturing), can-meet-in-person — so an operator can represent them; the agent fills what it can from web + Tenkara (volumes come from `materials.annual_volume_expected`) and leaves the rest null for ops to complete. **Triggers:** on-demand (the "Generate / Regenerate" button on the org's Client Profile tab) and automatically when ops add a note/file. The **hourly run is a light backstop** (`refreshStaleClientProfiles`, capped ~3/run since each call hits web_search) that re-researches stale/missing profiles. Ops can **edit** the summary/type to correct it, which sets `manual_override` so auto-refresh skips it (an explicit Regenerate overrides). OA writes only; never stages drafts. Uploads land in the private `client-uploads` storage bucket; text/markdown/csv is extracted inline (other types stored, parsing is a fast-follow).

---

## Pipeline view

```
Each agent below runs on its own cron in its own invocation (no shared budget):

Agent 03 scout (every 2h) ──► raw leads (graph + web) + sourcing CSV (incl. existing quotes)
        │
        ▼  Agent 06 enrichment (every 30m): raw ──► enriched   (persistent contact discovery)
        ▼  Agent 04 outreach   (every 30m): enriched ──► ready_for_outreach   (Missive draft, Agent 10 QA inline)
        ▼  👤 operator reviews & clicks Send in Missive ──► supplier replies
        ▼  Agent 08 (every 30m) detects + drafts a reply ──► 👤 Send

Side-channels:
  - Agent 02 (daily): expiring-quote revalidation drafts (QA inline)
  - Agent 05 (daily): marketplace price changes → review → manual Tenkara update
  - Agent 07 (daily 2pm): >14d stale → case; + Slack nudge on un-actioned work
  - Agent 01 (*/5): heartbeat
```

The only human gate in the happy path is **Send**. Promote/Drop on the Leads tab remain manual overrides.

---

## Platform Extraction (per-client tab · DEV-only for now)

**What it is:** a per-client surface (`/work/orgs/[slug]/extraction`, the violet **DEV** tab at the end of the org sub-nav) that shows everything the agents have pulled out of supplier emails for that client, framed the way the Tenkara platform frames it, so it can be pulled into Tenkara. Read-only; Tenkara is never written from here.

**Two sections:**
- **Quote board** — every quote line extracted from supplier replies + attachments: price, per-unit, pack, grade, **lead time, MOQ, payment terms**, source, confidence. Each row has a **Copy** button (tab-separated line to paste into Tenkara) and the table exports to CSV. When the client has dealbreaker document rules, a **Docs** column shows per-supplier ✓ / "Missing: CoA, SDS".
- **The bench** — vendor qualification. Reads the client's **Sourcing Rules** from Tenkara (`user_supplier_settings.pre/post_order_requirements`): CoA, SDS, TDS, sample, certifications, custom statements/testing/documentation, shelf life — each with **Requested** / **Dealbreaker** flags. Shows: the requirement checklist (with a warning banner for unmet dealbreakers), a **By-supplier** qualified/blocked view, and a **Documents received** list with parsed fields (CoA assay/lot, cert validity, expiry badges) and a link to the original.

**The qualification loop (how the data gets there):**
1. **Ask** — Agent 15 (reply-manager) appends the client's *Requested* documents to the follow-up reply, once per thread. Instant-quoters (a `price_given` first reply) get a short docs-only follow-up so they're asked too.
2. **Capture** — the Tenkara inbound webhook (`lib/tenkara-inbound.ts`) records every non-inline reply attachment into `supplier_documents`, classified by filename/type (`lib/supplier-documents.ts`).
3. **Extract** — content is parsed per doc type (`lib/document-extract.ts`): CoA lot/assay/dates, cert validity, SDS revision, plus a promoted `expires_on`.
4. **Surface** — all of the above renders on The bench / Quote board.

**Key files:** page `app/(app)/work/orgs/[slug]/extraction/page.tsx`; `components/extraction-quote-board.tsx`; libs `tenkara-requirements.ts`, `supplier-documents.ts`, `document-extract.ts`; migrations `0042` (quote terms), `0043`/`0044` (supplier_documents + extracted). Requirements read the live Tenkara DB via `tenkaraQuery` (read-only).

**Status / caveats:** DEV-only tab (`dev: true` in the org `layout.tsx` sub-nav) — flag-and-show, **nothing is blocked/held/excluded**. Only **new** inbound is captured (no backfill). Per-supplier matching is by `supplier_id` else normalized name. Legacy Missive `email-scanner` path is not wired for doc capture (Tenkara webhook only).

---

## Manual trigger / inspection

```bash
# Trigger one agent (e.g. drive the pipeline, or scan inbound):
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://ops-agents-vu4o.vercel.app/api/cron?slug=agent-03-lead-creator"
```

```sql
-- last 10 runs across the fleet
select a.slug, ar.status, ar.summary, ar.items_processed, ar.run_finished_at
from agent_runs ar join agents a on a.id = ar.agent_id
order by ar.run_finished_at desc nulls last limit 10;

-- events for a run
select level, step, message, data from agent_run_events where run_id = '<RUN_ID>' order by at asc;
```

## Env vars

| Var | Used by |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | all |
| `TENKARA_READONLY_DATABASE_URL` | 02, 03, 05, 06 |
| `MISSIVE_API_TOKEN` | 02, 04, 08 |
| `ANTHROPIC_API_KEY` | 03 (scout), 08 (reply), Ops assistant |
| `SLACK_BOT_TOKEN` | 02, 07, 11 |
| `CRON_SECRET` | trigger path (all) |
| `OUTREACH_MAX_DRAFTS_PER_RUN` | 04 (optional, default 5) |
