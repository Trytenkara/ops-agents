---
name: Browserbase Price Pull
description: Log into marketplaces behind a sign-in wall and pull price/tier info for a listing, using Browserbase cloud browsers with rotating residential proxies (IP-ban workaround). Use for the login_required marketplace leads that Agent 05's web_search pass can't read. Returns pricing in the same shape as Agent 05 (marketplace_pull / price_tiers).
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

- `pull.mjs` — CLI entry: rotate → (login) → navigate → extract.
- `src/session.mjs` — Browserbase session factory, proxy config, `withRotatingSession`, block detection.
- `src/adapters.mjs` — per-marketplace login registry.
- `src/extract.mjs` — Claude-based price/tier extraction from rendered page text.
- `check-rotation.mjs` — exit-IP rotation proof.

## Auto-provisioned accounts + batch pull (Ben's feature)

Gated marketplaces hide pricing behind a sign-in wall (Agent 05 returns `login_required`). This flow **creates a per-org account**, then logs in on a schedule and pulls prices for that org's gated leads.

**Data model** — OA table `marketplace_accounts` (migration `0049`): one row per `(org_id, host)` with the client `signup_email`, generated `password`, and a `status` lifecycle: `pending → signing_up → verifying → active → (banned|failed)`. The client's purchasing email lives on `orgs.purchasing_email` (set per org; inbox auto-detection is a follow-up).

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
node batch.mjs --no-login --all-active --skip-internal --limit 40   # scheduled fleet pass (real clients)
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
