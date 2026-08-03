---
name: Browserbase Price Pull
description: Pull/refresh marketplace price & tier info for leads Agent 05 couldn't read, via a cheap-first CASCADE — Tier A web_fetch+web_search (subagent workflow, repairs dead/wrong URLs), then Tier B Browserbase+Stagehand cloud browsers with rotating residential proxies (JS render, click-through, per-size ladders), then native Browserbase Agent / account login. Results merge keep-best into marketplace_pull / price_tiers. Use to price/refresh marketplace listings for sourcing clients. See "The cascade" section for the canonical run.
metadata:
  version: "0.1.0"
---

# Browserbase Price Pull

Pulls pricing/tier data from marketplace listings that require a **login** — the cases Agent 05's `web_search` recheck returns as `login_required`. It drives a real cloud browser (Browserbase) through a **rotating residential proxy**, logs in with a per-marketplace account, renders the page, and extracts the price ladder with Claude in the same JSON shape Agent 05 writes to `leads_in_flight.payload.marketplace_pull` / `price_tiers`.

## Why Browserbase + proxies (the ban workaround)

Repeatedly logging into the same marketplace from one datacenter IP gets that IP banned. Every Browserbase session here is created with `proxies: true` (rotating US residential IP) and stealth fingerprinting. The rotation helper (`withRotatingSession`) tears down the session and opens a **new one with a different geolocation** whenever a block is detected (HTTP 403/429/503 or block text / CAPTCHA), so each retry comes from a fresh IP. Verified: 3 sessions → 3 distinct residential exit IPs.

## Setup

- `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` — already in `/workspace/.env`.
- Anthropic: uses the Gamut platform proxy automatically (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `X-Superagent-*` headers). No extra config.
- **Marketplace credentials** — per site, add `<SLUG>_EMAIL` and `<SLUG>_PASSWORD` under Settings → Secrets (e.g. `KNOWDE_EMAIL` / `KNOWDE_PASSWORD`). Slugs are defined in `src/adapters.mjs`.

## Usage

Pull one listing:
```bash
cd /workspace/.claude/skills/browserbase-price-pull
set -a; . /workspace/.env; set +a
node pull.mjs --url "<listing_url>" --supplier "Acme" --material "Refined Glycerin"
```
Prints one JSON object:
```json
{"classification":"current_price_found|needs_review|login_required|link_broken",
 "current_price":number|null,"currency":"USD","pack_size":"25KG","unit_price":number|null,
 "tiers":[{"pack_size":"25KG","price":123,"unit_price":4.92}],"notes":"..."}
```

Prove IP rotation:
```bash
node check-rotation.mjs 3      # opens 3 proxied sessions, prints each exit IP
```

## Adding a marketplace

Edit `src/adapters.mjs` — add an entry keyed by bare hostname (no `www.`) with a `slug`, `loginUrl`, and a `login(page, {email,password})` routine (Playwright selectors). Then add `<SLUG>_EMAIL`/`<SLUG>_PASSWORD` secrets. Domains with **no** adapter are still fetched directly (no login) and extracted — useful when a "login_required" was a false positive and the price is actually public.

Top login_required marketplaces by volume (candidates to add first): knowde.com, bulkfoods.com, echemi.com, indiamart.com, wholesale.frontiercoop.com, starwest-botanicals.com, ingredientsonline.com, alibaba.com, pharmaoffer.com, gather.tracegains.com.

**Verified 2026-07-27 — knowde.com is NOT a signup/price-pull target.** `/sign_in` and `/sign_up` both 404 (the old login adapter URL is stale), the public site is sales-led ("Get a Demo"), and product pages are **RFQ-only** ("Request Sample / Request Document / Request a quote") — no list price even behind a login. Pilot the account-signup flow on a true self-serve wholesale e-commerce marketplace instead (bulkfoods.com, ingredientsonline.com, starwest-botanicals.com, wholesale.frontiercoop.com), where logging in reveals an actual price ladder.

## Files

- `pull.mjs` — CLI entry (passive): rotate → (login) → navigate → extract.
- `pull-agentic.mjs` — CLI entry (agentic): drive the site with Stagehand → extract. See below.
- `src/session.mjs` — Browserbase session factory, proxy config, `withRotatingSession`, block detection.
- `src/adapters.mjs` — per-marketplace login registry.
- `src/extract.mjs` — Claude-based price/tier extraction from rendered page text.
- `src/agentic.mjs` — Stagehand agentic pull (popup-close + on-site search + variants + product-page navigation), then `extractPricing`.
- `check-rotation.mjs` — exit-IP rotation proof.

## Agentic pull (Stagehand) — the interactive path

The passive path (`pull.mjs` / `batch.mjs` fetch+extract) only reads whatever text is already on the landing URL. Most marketplace leads point at a supplier **root domain**, so there is nothing to extract and the lead returns `needs_review` even when the price is one search away. The agentic path drives the page like a person:

1. **Close popups** — cookie banners, newsletter/subscribe modals, region selectors.
2. **Search on-site** — finds the site's search box and types the material.
3. **Tries name variants** — `"Cocamidopropyl Betaine (CAPB)"` → also `"Cocamidopropyl Betaine"` and `"CAPB"` (splits the parenthetical), retrying until product results appear.
4. **Opens the matching product page**, then extracts the ladder with the same `extractPricing` used everywhere else, so the result shape and `writePull` are unchanged.
5. **Per-size sweep** — if the product has a size/variant selector, it selects EACH option in turn and reads the single price the page then renders, producing a real per-size ladder instead of a `$5.99 - $23.99` range.

Built on **Stagehand** (`@browserbasehq/stagehand`), Browserbase's own agent framework — it runs on the exact same proxied cloud sessions. Navigation inference uses the **Browserbase Model Router** (`model: "auto"`, billed on `BROWSERBASE_API_KEY`, no provider key). Override the nav model with `BROWSERBASE_STAGEHAND_MODEL`. Price extraction still runs through the Anthropic/Gamut proxy (`extract.mjs`), because Stagehand's accessibility-tree extract mis-mapped variant→price where the innerText+Claude extractor did not.

**Division of labor (deliberate):** the LLM agent *drives* (closes popups, searches, clicks size options) but does NOT *read* the prices — an agent rounds/paraphrases numbers, so deterministic code reads each price via `extractPricing`. Stagehand's agent *structured output* (`agent.execute({output})`) is not enabled on this Browserbase account (returns `undefined` / "Failed to execute task: Not found"), which is another reason not to trust the agent for the numbers. CUA / hybrid (vision) agent modes exist and are better at pure clicking, but require a pinned vision model and cost more per step; DOM-mode `auto` + the popup/size helpers below has been sufficient.

**Popup safety (learned the hard way):** the pre-nav popup sweep only ever clicks Reject/Accept/Close/X/"No thanks" — NEVER Subscribe/Submit/Continue or "Manage preferences" (the former submitted a newsletter form and knocked the agent off the product page; the latter opened nested dialogs that ate the step budget). It also presses Escape. The agent's own instruction repeats these rules and tells it that it STARTS on the target page, so it captures the price there before wandering.

**Size-sweep mechanics (two paths):**
- **`<select>` dropdown (path A, deterministic):** a native `<select>` only recomputes the price when a real `change` event fires — Stagehand's DOM `act` sets the option value *without* firing it, so the displayed price never moves (this is why MakingCosmetics read `$790` for all five sizes). The sweep instead sets `select.value` and dispatches `input` + `change` via `page.evaluate`, then reads the price the site renders. Verified on MakingCosmetics: 250ml $9.90 / 1L $22.50 / 1Gal $54.65 / 40lb $198.75.
- **Non-`<select>` variants (path B):** radio buttons, swatch/pill links, Shopify variant buttons — enumerated with `observe()` and clicked with `act()`, price read after each.
- After selecting, the price is read with a **focused** extract ("the single price currently displayed for the selected size"), not a whole-page read — a whole-page read re-anchors on the same static number every time.

**Never a false mapping:** the size-sweep is trusted only when selecting different sizes yields *different* prices. If every size reads the same number (a static range that doesn't update on selection, e.g. Candles & Supplies), the sweep is **discarded** and the result falls back to the honest range + `needs_review` — it never asserts a guessed per-size price.

**Observability:** every run emits a step trace (popup-sweep actions, agent actions with URLs, size-sweep readings) via `onStep`; `pull-agentic.mjs` prints it to stderr and the live Browserbase session URL is printed up front so a human can watch. The result also carries `navTrace` (the agent's action list) and `navMessage`.

**Hard rules baked into the agent prompt:** never log in / register, never submit an RFQ / "request a quote" / "contact supplier" / newsletter form, never enter personal info. If the price is only behind a login or RFQ, it stops (acceptable outcome). Never fabricates a price — an unreadable listing stays `needs_review`/`login_required`, never a guessed number.

Single listing:
```bash
node pull-agentic.mjs --url "<listing_url>" --supplier "Acme" --material "Cocamidopropyl Betaine (CAPB)" [--max-steps 12]
```
Batch (opt-in with `--agentic`; one fresh proxied session per lead, so Stagehand handles IP rotation itself):
```bash
node batch.mjs --agentic --org california-chemicals --limit 10
node batch.mjs --agentic --all-active --skip-internal --limit 20
```
Cost/latency is higher than the passive `--no-login` pass (one browser agent session per lead), so keep it bounded with `--limit` and run the cheap `--no-login` pass first; use `--agentic` for the root-domain / search-required survivors it leaves behind.

**Deps:** `@browserbasehq/stagehand` + `zod` (installed in this skill's `node_modules`).

## Native Browserbase Agents path (highest abstraction) — `pull-bbagent.mjs`

Instead of orchestrating `act`/`observe`/`extract` + the size-sweep ourselves (the Stagehand path above), call a **Browserbase Agent** directly via the native **Agents API** (`POST /v1/agents/runs`). You describe the goal in natural language; Browserbase runs an autonomous agent (browse, search, click through variants, close popups) and — because the Agent carries a `resultSchema` — returns **structured output natively**. This is the structured-output the Stagehand SDK agent could NOT produce on this account.

- `src/bbagent.mjs` — REST client (raw fetch, `X-BB-API-Key`): `startRun`, `pollRun`, `runAgent` (start+poll), `runBatch` (fan out many concurrently), `listAgents`, and `toMarketplacePull` (maps `result.output` → the `marketplace_pull` shape, `source: "browserbase_agent"`; never fabricates — no numeric price ⇒ `needs_review`).
- `pull-bbagent.mjs` — CLI. `--url --material [--supplier] [--agent-id <id>]`; `--list` lists your saved agents. Reads `BROWSERBASE_AGENT_ID` from env if `--agent-id` omitted.

Reusable vs ephemeral: pass `--agent-id` (or `BROWSERBASE_AGENT_ID`) to run a **saved agent** created in the dashboard (its `systemPrompt` + `resultSchema` drive behavior). With no agentId, a run still works but you must supply a `resultSchema` per run to get structured output. Target values are passed as `%variables%` (`url`, `material`, `supplier`).

Tradeoffs vs the Stagehand path: the native agent is **slower** (~6–8 min/run vs ~2 min) but needs **zero** custom navigation/size-sweep/popup code and returns clean structured tiers. Runs are async — start, then poll to a terminal state (`COMPLETED`/`FAILED`/`STOPPED`/`TIMED_OUT`).

**Concurrency / scanning many materials:** the account allows concurrent sessions, so `runBatch(items, {resultSchema|agentId})` fires all runs at once (`startRun` for each), then polls them together — wall-clock ≈ the single slowest run, not the sum. Verified 5 CAPB sites in parallel, all `COMPLETED` with full per-size ladders (incl. Crafter's Choice/Wholesale Supplies Plus: 2oz $1.40 → 450lb $691.81). Use this to sweep a whole material list in one pass.

## The cascade (canonical way to run — cheap-first, each tier covers the others' gaps)

Run methods cheapest-first and only escalate the residue; results MERGE via `writePull` (keep-best, never wipe a good price). No single method is a point of failure — each tier's blind spot is another tier's strength (verified: web tier priced 11/14 leads Browserbase scored zero on, via link-repair; Browserbase gets the JS-rendered ones the web tier can't).

| Tier | What | Cost | Best at | Blind spot |
| ---- | ---- | ---- | ------- | ---------- |
| 0 | **Agent 05** `web_search` (Vercel fleet) | ~free | first flag | JS/gated → `needs_manual_pull` |
| **A** | **web_fetch + web_search workflow** (`webfetch-workflow.js`, one subagent/lead) | ~cheap, no browser | SSR prices + **repairing dead/wrong/gated URLs** | JS-rendered variation prices |
| B | **Browserbase + Stagehand** (`batch.mjs --no-login --concurrency N`) | ~$ + ~2.4 min/lead | JS render, click-through, **per-size ladders** | truly dead links, hard logins |
| C | **Native Browserbase Agent** (`batch.mjs --escalate`) | ~$$ + 6–8 min/run | hardest recoverable | quota-capped (50/period, resets ~Aug 24) |
| D | **Account login** (`signup.mjs` + active `marketplace_accounts`) | setup + human confirm | genuinely walled self-serve marketplaces | RFQ-only sites (no price even logged in) |

### Canonical daily run (mandatory cadence)
Tier A is agent-driven (web_fetch/web_search are agent tools), while Tier B is the Node CLI. Every daily run must execute these steps in this exact order for every org returned by `node webtier.mjs orgs`:

1. Load `/workspace/.env` and generate `node webtier.mjs worklist --org <slug> --mode all`.
2. Invoke `webfetch-workflow.js` with the complete worklist as workflow args.
3. Persist the complete workflow result with `node webtier.mjs write /tmp/webresult-<slug>.json`.
4. Run Tier B once across the remaining real-client residue:
   `node batch.mjs --harvest --no-login --all-active --skip-internal --limit 100000 --concurrency 90`.
5. Keep Tier C off until its quota-reset task enables it.
6. Finish with `node webtier.mjs coverage`. Its one-line-per-client output is the required run summary.

Tier A must never be silently skipped. If the workflow is denied, interrupted, returns a platform-balance error, or produces fewer results than the worklist, retry or resume it until every lead has a result. Do not start Tier B before Tier A is fully persisted. Do not mark the daily run complete before the coverage summary prints. Tier B runs even when Tier A prices every lead, because it also harvests any durable in-flight Browserbase work.

`--mode residue` remains available for manual post-Browserbase diagnostics, but the daily Tier A pass always uses `--mode all`. Tier A subagents bill the platform workspace budget. Tier B extraction uses the Gamut proxy; `ANTHROPIC_API_KEY_NEW` is the funded direct key.

### Legacy tier table (Browserbase-only view)

| Tier | What | Cost | When |
| ---- | ---- | ---- | ---- |
| 0 | **Agent 05** `web_search` (Vercel fleet) | ~free | every lead; flags `needs_manual_pull` + reason |
| 1 | **`--no-login` pull = passive read + Stagehand on EVERY lead** | ~$ + ~2 min/lead (own Stagehand session per lead) | every Tier-0 give-up |
| 2 | **Native Browserbase Agent** (`--escalate`) | ~$$ + 6–8 min/run | ONLY Tier-1 failures that are recoverable |

**Tier 1 change (Ben, 2026-07-29):** the `--no-login` pass no longer just does the cheap passive innerText read. For EVERY lead it now runs the passive read AND a Stagehand agentic pull (`agenticPull` — its own fresh proxied session, popup-close + on-site search with name variants + per-size sweep), then keeps whichever result is better (`chooseBest`: a real price beats none; richer ladder wins; ties favor Stagehand). This runs regardless of the passive outcome, including on passive-blocked/RFQ leads (Stagehand's own IP + navigation can recover some). Never fabricates — both readers guard against guessed prices. Winning source is tagged `browserbase_stagehand` vs `browserbase_login`. Cost/runtime is now dominated by one Stagehand session per lead (~2.4 min each measured), so the pass is SLOW.

**Parallel fan-out (2026-07-29) — the real fix for the ~10-min session cap.** The Browserbase plan allows **100 concurrent sessions** (`GET /v1/projects/{id}` → `"concurrency":100`), so `--concurrency N` (capped at 90 in code) runs up to N Stagehand pulls AT ONCE (`pullLeadsParallel`), each lead in its own session. Hundreds of leads finish in a few minutes instead of leads×2.4 min — same total browser-minutes, just parallel, and Ben sees ~N browsers clicking at once. Measured: sequential ≈ 141 s/lead; a 57-lead California run at `--concurrency 90` finished in ~3–4 min (18 priced / 39 unresolved, one site-level 429, no LLM rate-limiting). This makes the whole run fit under the session cap in ONE run, so the every-30-min time-boxing is retired. (`--max-minutes` + stalest-first ordering are still in the code as a fallback for sequential/manual runs.)

**Refresh-all + reflect-live price (2026-07-29, Sam).** `--refresh-all` selects EVERY marketplace lead (`payload->marketplace_pull=not.is.null`), priced or not — because prices change day to day. `writePull` now:
- on a successful pull, ALWAYS rewrites `marketplace_pull.price` + `price_tiers` (not just the first time), and stamps `previous_price` + `price_changed_at` when the number moved — so the live price reflects the change.
- when a refresh can't read a price but the lead ALREADY had one, it KEEPS the last-known price and flags `refresh_failed_at` / `refresh_fail_reason` / `refresh_fail_notes` (the WHY) — never wipes good pricing on a transient miss.
- when there was no prior price, flags `needs_manual_pull` with `reason` + `last_notes` (the WHY), as before.

**Cron (2026-07-29): task `bfe6f5da`** "Marketplace price refresh (parallel Stagehand, ALL leads, daily 8AM)" — `0 8 * * *` America/New_York, running `node batch.mjs --harvest --no-login --refresh-all --all-active --skip-internal --limit 100000 --concurrency 90`. One run/morning refreshes every marketplace lead for every real client in parallel, in minutes. (~191 leads for California.) Superseded the capped/time-boxed tasks.

**Reliability hardening (2026-07-29) — from watching a live parallel run.** Four fixes in `agentic.mjs` + `batch.mjs`:
1. **Retry failed/blank navigation.** `attempt()` now: 404/410/451 → `link_broken` (no retry); a thrown/`!resp`/status-0 nav, or a `<50`-char blank render, throws `err.retry` → `agenticPull`'s existing loop rotates to a fresh IP (up to `maxAttempts=3`). Fixes the 2–3s "black-screen" give-ups (transient proxy failures now recover; e.g. `ERR_TUNNEL_CONNECTION_FAILED` retries, then honestly flags `link_broken` if still dead).
2. **Deterministic click-through.** The LLM agent's clicks were erroring (`error performing click`), so it searched but never opened a product. New `clickThroughToProduct` (`observe` the product-result link matching the material `materialVariants`, click via `actWithRetry`) + `actWithRetry` (re-`dismissPopups` + backoff, since a popup intercepting the click is the usual cause). Flow: dismiss → read landing → agent → `clickThroughToProduct` → read → `sizeSweep`.
3. **Per-host cap.** `HostGate` (default 4, `--host-cap`) + host-interleaved lead order in `pullLeadsParallel` — stops bursting one domain (the 429s) even though every session already has a distinct residential IP.
4. **Per-lead timeout + immediate retry.** `--lead-timeout` (default 220s) wraps each lead in `Promise.race`; the Stagehand session `timeout` (`BB_SESSION_TIMEOUT_SEC`, lead-timeout+20 ≈ 240s) reaps the browser server-side — no more sessions running to the 600s cap. On a timeout the worker **retries immediately in a fresh session** (up to `maxAttempts=3`, inline — never deferred/left hanging), since the worker-level `Promise.race` sits outside `agenticPull`'s own retry. Only after all attempts time out is it written `needs_review`. Defaults apply to the cron with no flag changes.

One command does Tier 1 then Tier 2:
```bash
node batch.mjs --no-login --escalate --all-active --skip-internal --limit 40 --agent-limit 10 [--agent-id <id>]
```
Escalation rules (built in):
- **Only recoverable reasons** escalate — `login_required` / `needs_review`. `link_broken` never does (a 404 won't yield to an agent).
- **No re-paying for dead ends:** each escalated lead is stamped `marketplace_pull.agent_attempted_at`; already-attempted leads are skipped next run unless `--agent-retry`.
- **Capped + prioritized:** `--agent-limit N` (default 10) bounds Tier 2 per run; orgs are processed real-clients-first (`is_internal ASC`), matching fleet priority.
- **`--agent-id`** points Tier 2 at a saved dashboard Agent (its own systemPrompt + resultSchema); omit it to use the inline schema.
- Agent results are written with `source: "browserbase_agent"` (vs `browserbase_login` for the passive tier), so you can tell which tier resolved each price.

The standalone `--agentic` path (Stagehand act/observe + size-sweep) is superseded by Tier 2 (the native agent is more capable and returns structured output) and is kept only as an optional middle option.

**Durability (`--harvest`):** Tier 2 stamps each lead with its `agent_run_id` + `agent_attempted_at` the moment the run is *started* (before polling), and writes each result incrementally as it completes. If the process dies mid-run, `--harvest` recovers the results by re-polling those run ids — because Browserbase does NOT store resolved run variables, so a run→lead mapping only survives if we persist it ourselves. The daily cron leads with `--harvest` to self-heal. **Do NOT wrap the tiered job in a short external `timeout`:** Tier 1 is sequential (~40 min for 80 leads) and Tier-2 agents are slow, so the whole run needs ~30–45 min; a short timeout kills it at the Tier-2 handoff and (pre-fix) orphaned the runs. Lesson learned from a backfill that lost ~25 paid agent runs.

## Auto-provisioned accounts + batch pull (Ben's feature)

Gated marketplaces hide pricing behind a sign-in wall (Agent 05 returns `login_required`). This flow **creates a per-org account**, then logs in on a schedule and pulls prices for that org's gated leads.

**Data model** — OA table `marketplace_accounts` (migrations `0049`, `0071`): one row per `(org_id, host, signup_email)` with the client `signup_email`, generated `password`, and a `status` lifecycle: `pending → signing_up → verifying → active → (banned|failed)`. The client's purchasing email lives on `orgs.purchasing_email` (set per org; inbox auto-detection is a follow-up). A host can hold several accounts: `created_by` is `agent` (this skill) or `ops` (entered by an operator in the Control Room Supplier Validation tab, with `created_by_email` and an optional `supplier_profile_id` link). `getAccount(orgId, host)` returns the most usable row (active first), and `batch.mjs` logs in with every `active` account, ops-entered ones included.

**Semi-auto verification** — signups use the client's *real* purchasing email, and the confirm-link email lands in the client's mailbox (which we can't read). So `signup.mjs` registers the account and opens a **case** ("click the confirm link"). A human clicks it once; then set the account `active` and `batch.mjs` pulls automatically from then on.

### Provision an account
```bash
node signup.mjs --org <slug> [--host knowde.com] [--email buyer@client.com] [--dry-run]
```
Creates the `marketplace_accounts` row, runs a proxied Browserbase signup, and (on `verification_pending`) opens the confirm-link case + sets status `verifying`. `--dry-run` resolves org/email/identity and prints the plan without touching the DB or a browser.

**After the human clicks the confirm link**, flip the row to active:
```sql
update marketplace_accounts set status='active', verified_at=now() where id='<id>';
```

### Pull prices for verified accounts
```bash
node batch.mjs [--org <slug>] [--host knowde.com] [--limit 15] [--dry-run]
```
For each `active` account: rotating proxied login → for each gated lead, navigate + extract → write `leads_in_flight.payload.marketplace_pull` (same shape as Agent 05). Ban-safe: rotating residential IPs, per-run lead cap, jittered delays. Run on a **slow schedule** (a Gamut scheduled task, container-side — Playwright can't run in the Vercel fleet).

### No-login pull (false-positive recovery — no account needed)
```bash
node batch.mjs --no-login --org <slug> [--host <host>] [--limit N] [--dry-run]
node batch.mjs --no-login --all-active --skip-internal --limit 100000   # daily fleet pass: passive + Stagehand on ALL eligible leads, real clients
```
Flags:
- `--all-active` — every sourcing org (`sourcing_status` in `active` **or** `sourcing_only`), real clients first (ordered `is_internal ASC`). NOTE (fixed 2026-07-27): previously this selected `sourcing_status=active` only, which is just the internal test org — it silently skipped every real client (California/McGinley are `sourcing_only`).
- `--skip-internal` — drop `is_internal=true` test orgs (Tenkara Internal, Arlon). Use on the scheduled *paid* pass so Browserbase budget goes to real clients only.
- `--reasons a,b` — which Agent-05 give-up reasons to attempt. Default `login_required,needs_review` (both recoverable: false-positive login walls + JS-rendered prices missing from search snippets). `link_broken` is never selected.
- `--limit N` — max leads per org per run.
Many `login_required` leads aren't actually gated — Agent 05's `web_search` over-flags generic "sign in" nav as a paywall, but the price is public. This mode fetches those pages directly through a proxied Browserbase session (JS-rendered, no login) and extracts the price, re-classifying genuinely-walled pages back to `needs_manual_pull`. **Resilience (fixed 2026-07-27) — one bad host no longer aborts the batch:** (a) a body-text block signal on a 200 page is a per-listing wall/bot-check → that lead is flagged `login_required` and the run continues (NOT an IP rotation); (b) an HTTP 403/429/503 gives the lead 2 fresh-IP attempts (tracked per-lead across rotations via `banCount`), then flags just that lead and continues — so a single host that hard-blocks our proxy range can't kill the leads sitting on every other host. `withRotatingSession` maxAttempts raised 3→6. Previously any exhausted rotation aborted the entire run (observed on CA: run 1 died at a false 200-block after 12/38 leads; run 2 died at a real 403 after ~13). **Verified 2026-07-27** on the Tenkara/Sierra org: 4 of 6 "gated" leads pulled real prices with no account (Black Pepper $8/$68.99/$143.75, Onion Powder $7.65); Tridge correctly stayed `login_required`. This is the highest-value, zero-ban-risk first pass — run it before provisioning any accounts.

### Hydration fix (2026-07-28) — the no-login pass was under-extracting

`batch.mjs`'s no-login path read `document.body.innerText` immediately after `domcontentloaded`, before JS-rendered price widgets populated, so dynamic-price marketplaces (most of them) came back `needs_review`/`link_broken` with "no numeric price rendered" even though the price was public. `pull.mjs` never had this bug because it waits for `networkidle` + retries until body text settles. Ported that same hydration wait into `batch.mjs` before the body-text read. Verified on California Chemicals CAPB leads: pages that returned 0 prices on the old code (Natural Bulk Supplies, Chemistry Store) now extract full ladders. If leads still come back `needs_review` en masse, check this wait first. Genuinely RFQ-only pages (Stepan "Quote Required", "from $X" with no tiers) correctly stay flagged.

### New files
- `signup.mjs` — provision one account (create row → Browserbase signup → verify case).
- `batch.mjs` — log in to active accounts and pull their gated leads.
- `src/accounts.mjs` — OA REST access (orgs, marketplace_accounts, leads, cases).
- `src/adapters.mjs` — now also holds `signup()`, `classifySignup()`, `generatePassword()`, `signupIdentity()`.

### Not yet wired
- Inbox auto-detection of the client purchasing email (currently set manually on `orgs.purchasing_email`).
- Password encryption-at-rest (stored plaintext behind service-role RLS for the pilot).
- Signup adapters beyond `knowde.com` (add per marketplace as accounts are provisioned).
