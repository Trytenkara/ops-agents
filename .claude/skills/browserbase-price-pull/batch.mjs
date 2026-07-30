// Pull gated marketplace prices for every verified account (Ben's feature, step 2).
//
// For each `active` marketplace_accounts row: open a proxied Browserbase session,
// log in, and pull pricing for that org's login-gated leads (the ones Agent 05
// marked marketplace_pull.needs_manual_pull / login_required). Results are
// written back to leads_in_flight.payload.marketplace_pull in the same shape
// Agent 05 uses, so the Marketplace-pricing tab renders them identically.
//
// Ban-safety: proxied rotating residential IPs (withRotatingSession), a per-run
// lead cap, and jittered delays between page loads. Run on a slow schedule.
//
// Usage:
//   node batch.mjs                       # all active accounts
//   node batch.mjs --org sierra          # one org
//   node batch.mjs --host knowde.com     # one marketplace
//   node batch.mjs --limit 10            # cap leads per account this run
//   node batch.mjs --dry-run             # list what would be pulled, no browser

import { withRotatingSession, BanError, looksBlockedStatus, looksBlockedBody, isSessionDead } from "./src/session.mjs";
import { adapterForHost } from "./src/adapters.mjs";
import { extractPricing } from "./src/extract.mjs";
import { agenticPull } from "./src/agentic.mjs";
import { startRun, pollRun, toMarketplacePull } from "./src/bbagent.mjs";
import { listAccounts, getOrg, listActiveOrgs, listLoginRequiredLeads, writePull, updateAccount, stampAgentRun, listPendingAgentRunLeads } from "./src/accounts.mjs";

// Tier-2 escalation: the native Browserbase Agent, run only on leads the cheap
// passive Tier-1 pass could not resolve. Shape of its structured output:
const AGENT_RESULT_SCHEMA = {
  type: "object",
  properties: {
    classification: { type: "string", enum: ["current_price_found", "needs_review", "login_required", "link_broken"] },
    currency: { type: "string" },
    tiers: {
      type: "array",
      items: { type: "object", properties: { pack_size: { type: "string" }, price: { type: "number" } }, required: ["pack_size", "price"] },
    },
    notes: { type: "string" },
  },
  required: ["classification", "tiers"],
};
const AGENT_TASK =
  "Go to %url% and capture the full per-size price ladder for %material% from supplier %supplier%. For EACH pack size, select it and record the exact price shown. Close any popups. Do NOT log in, register, or submit any RFQ / request-a-quote / contact / newsletter form.";
const AGENT_MAX_WAIT_MS = 540000; // native agent runs are slow (~6-8 min)

const MAX_LEADS_PER_ACCOUNT_DEFAULT = 15; // bounded per run; the backlog drains across scheduled runs without hammering one site
const MIN_DELAY_MS = 4000;                 // jittered gap between page loads — gentle, human-ish pacing
const MAX_DELAY_MS = 9000;

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function jitter() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return MIN_DELAY_MS + Math.floor((buf[0] / 2 ** 32) * (MAX_DELAY_MS - MIN_DELAY_MS));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- result merge (passive read vs Stagehand) ---------------------------
// Ben's directive: Tier 1 runs Stagehand on EVERY lead, so each lead yields two
// candidate results (the cheap passive innerText read + the Stagehand agentic
// drive). Keep the better one: a real price beats no price; among priced results
// the richer ladder wins; ties favor Stagehand (its per-size sweep is more
// granular). Never fabricates — both candidates already guard against that.
function hasPrice(r) {
  return !!r && r.classification === "current_price_found" && r.current_price != null;
}
function tierCount(r) {
  return Array.isArray(r?.tiers) ? r.tiers.length : 0;
}
function chooseBest(passive, agentic) {
  const cands = [agentic, passive].filter(Boolean); // agentic first → ties favor Stagehand
  cands.sort((a, b) => {
    if (hasPrice(a) !== hasPrice(b)) return hasPrice(a) ? -1 : 1;
    return tierCount(b) - tierCount(a);
  });
  return cands[0];
}

// Pull a set of leads in one proxied (rotating) session. When `login` is
// provided we authenticate first (gated sites); otherwise we fetch the page
// directly — the false-positive case where Agent 05 flagged login_required but
// the price is actually public. Both paths render JS (Browserbase) and extract
// with the same model, and re-classify still-walled pages as needs_manual_pull.
//
// Stagehand-in-Tier-1 (Ben): after the passive read, EVERY lead also gets a
// Stagehand agentic pull (its own fresh proxied session — on-site search + name
// variants + per-size sweep) and we keep whichever result is better. This runs
// regardless of the passive outcome, including on leads the passive path flagged
// as blocked/RFQ, since Stagehand's own IP + navigation can recover some of them.
async function pullLeads(leads, { login, dryRun, deadline = 0 } = {}) {
  if (dryRun) return { pulled: 0, failed: 0, note: `would pull ${leads.length} lead(s)` };

  const done = new Set();       // lead ids already written this run — survive session rotation
  let pulled = 0;
  let failed = 0;
  let stoppedForTime = false;
  // A lead takes ~2.4 min (passive + Stagehand), so don't START one we can't finish
  // before the deadline — bail with ~1 min of headroom so the summary prints before
  // the session host kills the run at the ~10 min cap.
  const LEAD_BUDGET_MS = 165000;

  const banCount = new Map(); // per-lead 403/429/503 attempts — survives session rotation
  await withRotatingSession(async ({ page }) => {
    if (login) await login(page);

    for (const lead of leads) {
      if (done.has(lead.id)) continue;
      if (deadline && Date.now() + LEAD_BUDGET_MS > deadline) {
        stoppedForTime = true;
        console.log(`  ⏱ time budget reached — stopping before next lead (${pulled + failed}/${leads.length} done this run; rest resume next batch)`);
        break;
      }
      // --- Pass A: cheap passive innerText read (shared rotating session) ------
      // Produces a candidate result WITHOUT writing/continuing early, so Stagehand
      // (Pass B) always runs afterward and we write the merged best exactly once.
      let passive = null;
      try {
        const resp = await page.goto(lead.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        const status = resp?.status?.() ?? 0;
        // HTTP 403/429/503 = an IP block. Give the lead 2 fresh-IP attempts before
        // giving up the passive read — one host that blocks our proxy range must not
        // abort the shared-session read of leads on every other host.
        if (looksBlockedStatus(status)) {
          const n = (banCount.get(lead.id) ?? 0) + 1;
          banCount.set(lead.id, n);
          if (n < 2) throw new BanError(`blocked (status ${status})`); // rotate IP, retry passive read of this lead
          passive = { classification: "login_required", current_price: null, tiers: [], notes: `Host returns ${status} to proxy IPs after ${n} attempts; not publicly pullable (passive).` };
        } else {
          // Let JS-heavy marketplace pages hydrate before we read them, otherwise the
          // price widget hasn't rendered yet and extraction falsely returns needs_review.
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          for (let i = 0; i < 3; i++) {
            const len = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);
            if (len > 200) break;
            await page.waitForTimeout(2000);
          }
          const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "");
          if (looksBlockedBody(bodyText)) {
            passive = { classification: "login_required", current_price: null, tiers: [], notes: "Page-level block/bot-check on passive read (no IP ban)." };
          } else {
            passive = await extractPricing({ page, supplier: lead.supplier_name, material: lead.material_name });
          }
        }
      } catch (e) {
        if (e?.name === "BanError") throw e;   // real IP ban → rotate to a fresh IP
        if (isSessionDead(e)) throw new BanError("session died mid-loop"); // rotate + resume (done-set keeps progress)
        // Per-lead transient error on the passive read (extract failure, nav timeout) —
        // record it as a candidate and still let Stagehand try.
        passive = { classification: "needs_review", current_price: null, tiers: [], notes: `passive error: ${String(e?.message ?? e).slice(0, 180)}` };
      }

      // --- Pass B: Stagehand agentic pull — runs on EVERY lead (Ben) -----------
      // Its own fresh proxied session (own IP), closes popups, on-site search with
      // name variants, opens the product page, per-size sweep. Runs regardless of
      // the passive outcome — even blocked/RFQ passive results, since a fresh IP +
      // real navigation can recover some. Errors become a candidate, never abort.
      let agentic = null;
      try {
        agentic = await agenticPull({ url: lead.url, supplier: lead.supplier_name, material: lead.material_name });
      } catch (e) {
        agentic = { classification: "needs_review", current_price: null, tiers: [], notes: `stagehand error: ${String(e?.message ?? e).slice(0, 180)}`, source_url: lead.url };
      }

      // --- Merge: keep the better candidate, tag which reader resolved it -------
      const best = chooseBest(passive, agentic);
      best.source = best === agentic ? "browserbase_stagehand" : "browserbase_login";
      const gotPrice = await writePull(lead, best);
      done.add(lead.id);
      if (gotPrice) {
        pulled++;
        console.log(`  ✓ ${lead.supplier_name} × ${lead.material_name} → ${best.currency ?? "USD"} ${best.current_price}${tierCount(best) ? ` (${tierCount(best)} tier${tierCount(best) > 1 ? "s" : ""})` : ""} [${best.source === "browserbase_stagehand" ? "stagehand" : "passive"}]`);
      } else {
        failed++;
        console.log(`  · ${lead.supplier_name} × ${lead.material_name} → ${best.classification} (${(best.notes ?? "").slice(0, 90)})`);
      }
      await sleep(jitter());
    }
  }, { maxAttempts: 6 });

  return { pulled, failed, ...(stoppedForTime ? { stoppedForTime: true } : {}) };
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return "?"; }
}

// Per-host semaphore: even with distinct residential IPs, firing many leads at ONE
// host at once triggers that host's rate-limiter (the 429s). Cap concurrent
// in-flight sessions per host; a slot is handed straight to a waiter on release
// (no decrement) to avoid a check-then-increment race.
class HostGate {
  constructor(cap) { this.cap = Math.max(1, cap); this.n = new Map(); this.q = new Map(); }
  async acquire(host) {
    const cur = this.n.get(host) ?? 0;
    if (cur < this.cap) { this.n.set(host, cur + 1); return; }
    await new Promise((res) => { const w = this.q.get(host) ?? []; w.push(res); this.q.set(host, w); });
  }
  release(host) {
    const w = this.q.get(host);
    if (w && w.length) { w.shift()(); return; } // hand the slot over, count unchanged
    this.n.set(host, Math.max(0, (this.n.get(host) ?? 1) - 1));
  }
}

// Round-robin the leads across hosts so the flat worker pool naturally spreads
// load and the HostGate rarely has to block.
function interleaveByHost(leads) {
  const groups = new Map();
  for (const l of leads) { const h = hostOf(l.url); if (!groups.has(h)) groups.set(h, []); groups.get(h).push(l); }
  const lists = [...groups.values()];
  const out = [];
  let added = true;
  while (added) { added = false; for (const g of lists) { const x = g.shift(); if (x) { out.push(x); added = true; } } }
  return out;
}

// Abandon a lead that runs too long so its worker slot frees up (the Browserbase
// session self-terminates via its own server-side timeout). Marks it timedOut.
function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`lead timed out after ${Math.round(ms / 1000)}s`), { timedOut: true })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Concurrent fan-out (Ben): the Browserbase plan allows 100 concurrent sessions,
// so instead of pulling leads one at a time we run up to `concurrency` Stagehand
// pulls AT ONCE — each lead drives its own session (visible clicking) and the whole
// org drains in ~one lead's wall-time (~2.4 min) instead of leads×2.4 min. Same
// total browser-minutes, just parallel. A per-host cap keeps us from hammering one
// domain, and a per-lead timeout keeps a hung lead from holding a slot.
async function pullLeadsParallel(leads, { concurrency = 50, dryRun, deadline = 0, hostCap = 4, leadTimeoutMs = 220000, maxAttempts = 3 } = {}) {
  if (dryRun) return { pulled: 0, failed: 0, note: `would parallel-pull ${leads.length} lead(s) @concurrency=${concurrency} host-cap=${hostCap}` };
  let pulled = 0;
  let failed = 0;
  let stoppedForTime = false;
  let idx = 0;
  const ordered = interleaveByHost(leads);
  const gate = new HostGate(hostCap);

  async function worker() {
    while (true) {
      if (deadline && Date.now() > deadline) { stoppedForTime = true; return; }
      const i = idx++;
      if (i >= ordered.length) return;
      const lead = ordered[i];
      const host = hostOf(lead.url);
      await gate.acquire(host);
      try {
        // Immediate inline retry on timeout — the worker-level Promise.race is
        // OUTSIDE agenticPull's own retry, so a timed-out lead is re-run right here
        // in a fresh session (never deferred/left hanging). agenticPull returns a
        // classified result rather than throwing for normal cases, so the only
        // exception we retry on is the timeout itself.
        let result = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            result = await withTimeout(
              agenticPull({ url: lead.url, supplier: lead.supplier_name, material: lead.material_name }),
              leadTimeoutMs,
            );
            break;
          } catch (e) {
            lastErr = e;
            if (e?.timedOut && attempt < maxAttempts) {
              console.log(`  ↻ ${lead.supplier_name} × ${lead.material_name} → timed out (${Math.round(leadTimeoutMs / 1000)}s), retrying now (attempt ${attempt + 1}/${maxAttempts})`);
              continue;
            }
            break;
          }
        }
        if (result) {
          result.source = "browserbase_stagehand";
          const gotPrice = await writePull(lead, result);
          if (gotPrice) {
            pulled++;
            console.log(`  ✓ ${lead.supplier_name} × ${lead.material_name} → ${result.currency ?? "USD"} ${result.current_price}${tierCount(result) ? ` (${tierCount(result)} tier${tierCount(result) > 1 ? "s" : ""})` : ""}`);
          } else {
            failed++;
            console.log(`  · ${lead.supplier_name} × ${lead.material_name} → ${result.classification} (${(result.notes ?? "").slice(0, 80)})`);
          }
        } else {
          const note = lastErr?.timedOut ? `timed out after ${maxAttempts}×${Math.round(leadTimeoutMs / 1000)}s` : `stagehand error: ${String(lastErr?.message ?? lastErr).slice(0, 180)}`;
          await writePull(lead, { classification: "needs_review", notes: note, source: "browserbase_stagehand" });
          failed++;
          console.log(`  · ${lead.supplier_name} × ${lead.material_name} → needs_review (${note.slice(0, 80)})`);
        }
      } finally {
        gate.release(host);
      }
    }
  }

  const n = Math.min(Math.max(1, concurrency), ordered.length);
  console.log(`  ⇉ fanning out ${ordered.length} lead(s), up to ${n} concurrent Browserbase sessions (host-cap ${hostCap}, lead-timeout ${Math.round(leadTimeoutMs / 1000)}s, ${maxAttempts} attempts each)`);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return { pulled, failed, ...(stoppedForTime ? { stoppedForTime: true } : {}) };
}

// Agentic pull: one fresh proxied Stagehand session PER lead (the agent closes
// popups, uses the on-site search with material-name variants, and opens the
// matching product page before we extract). Higher yield on root-domain leads
// that the passive fetch can't read, at higher cost/latency — so it's opt-in
// (--agentic) and still bounded by --limit. Session-per-lead means Stagehand
// handles proxy/IP rotation itself; we don't share withRotatingSession here.
async function pullLeadsAgentic(leads, { dryRun } = {}) {
  if (dryRun) return { pulled: 0, failed: 0, note: `would agentic-pull ${leads.length} lead(s)` };
  let pulled = 0;
  let failed = 0;
  for (const lead of leads) {
    try {
      const result = await agenticPull({ url: lead.url, supplier: lead.supplier_name, material: lead.material_name });
      const gotPrice = await writePull(lead, result);
      if (gotPrice) {
        pulled++;
        console.log(`  ✓ ${lead.supplier_name} × ${lead.material_name} → ${result.currency ?? "USD"} ${result.current_price}  (${result.viewUrl})`);
      } else {
        failed++;
        console.log(`  · ${lead.supplier_name} × ${lead.material_name} → ${result.classification}${result.tiers?.length ? ` (${result.tiers.length} tier(s))` : ""} (${result.viewUrl})`);
      }
    } catch (e) {
      await writePull(lead, { classification: "needs_review", notes: `agentic error: ${String(e?.message ?? e).slice(0, 180)}` });
      failed++;
      console.log(`  · ${lead.supplier_name} × ${lead.material_name} → needs_review (error: ${String(e?.message ?? e).slice(0, 80)})`);
    }
    await sleep(jitter());
  }
  return { pulled, failed };
}

// TIER 2 — escalate the leads Tier 1 couldn't resolve to the native Browserbase
// Agent, concurrently. Only recoverable reasons (login_required / needs_review),
// never link_broken. Skips leads already tried by the agent (agent_attempted_at)
// unless --agent-retry, so the expensive tier never re-pays for dead ends.
async function escalateWithAgent(org, { agentLimit, agentId, retry, dryRun, hostFilter }) {
  let leads = await listLoginRequiredLeads(org.id, {
    reasons: ["login_required", "needs_review"],
    ...(hostFilter ? { host: hostFilter.replace(/^www\./, "") } : {}),
  });
  if (!retry) leads = leads.filter((l) => !l.payload?.marketplace_pull?.agent_attempted_at);
  leads = leads.slice(0, agentLimit);
  if (!leads.length) return { escalated: 0, pulled: 0 };
  console.log(`  ↑ escalating ${leads.length} unresolved lead(s) to the native Browserbase agent${dryRun ? " (dry-run)" : ""}`);
  if (dryRun) return { escalated: leads.length, pulled: 0, note: `would escalate ${leads.length}` };

  const stamp = new Date().toISOString();
  // Durable: START each run, then IMMEDIATELY stamp the lead with its agent_run_id
  // (before any polling). If this process dies, `--harvest` recovers the results
  // from those run ids — so a crash never loses the work we paid for.
  const started = await Promise.all(
    leads.map(async (lead) => {
      try {
        const s = await startRun({
          agentId,
          resultSchema: AGENT_RESULT_SCHEMA, // per-run override: guarantees structured tiers even if the saved agent has none
          task: AGENT_TASK,
          variables: {
            url: { value: lead.url, description: "starting product/listing URL" },
            material: { value: lead.material_name, description: "the material to price" },
            supplier: { value: lead.supplier_name || "(unknown)", description: "the supplier/vendor name" },
          },
        });
        await stampAgentRun(lead, s.runId, stamp);
        return { lead, runId: s.runId };
      } catch (e) {
        console.log(`    · ${lead.supplier_name} × ${lead.material_name} → start failed: ${String(e?.message ?? e).slice(0, 80)}`);
        return null;
      }
    }),
  );

  // Poll + write each result AS IT COMPLETES (incremental, not all-or-nothing).
  let pulled = 0;
  await Promise.all(
    started.filter(Boolean).map(async ({ lead, runId }) => {
      try {
        const done = await pollRun(runId, { maxWaitMs: AGENT_MAX_WAIT_MS });
        const mapped = toMarketplacePull(done, { url: lead.url });
        mapped.agent_attempted_at = stamp;
        mapped.agent_run_id = runId;
        const got = await writePull(lead, mapped);
        if (got) {
          pulled++;
          console.log(`    ✓ ${lead.supplier_name} × ${lead.material_name} → ${mapped.currency ?? "USD"} ${mapped.current_price}${mapped.tiers?.length ? ` (${mapped.tiers.length} tier(s))` : ""}`);
        } else {
          console.log(`    · ${lead.supplier_name} × ${lead.material_name} → ${mapped.classification} [${done.status}]`);
        }
      } catch (e) {
        console.log(`    · ${lead.supplier_name} × ${lead.material_name} → poll/write error: ${String(e?.message ?? e).slice(0, 80)}`);
      }
    }),
  );
  return { escalated: started.filter(Boolean).length, pulled };
}

// HARVEST — recover Tier-2 runs that were started but never written back (process
// died mid-poll). Reads agent_run_id off each pending lead, polls that run, and
// writes the result. Idempotent: resolved leads drop out of the pending set.
async function harvestAgentRuns(org, { dryRun } = {}) {
  const leads = await listPendingAgentRunLeads(org.id);
  if (!leads.length) return { harvested: 0, pulled: 0 };
  console.log(`  ⟳ harvesting ${leads.length} pending agent run(s) for ${org.slug}${dryRun ? " (dry-run)" : ""}`);
  if (dryRun) return { harvested: leads.length, pulled: 0, note: `would harvest ${leads.length}` };
  let pulled = 0;
  await Promise.all(
    leads.map(async (lead) => {
      try {
        const done = await pollRun(lead.runId, { maxWaitMs: AGENT_MAX_WAIT_MS });
        const mapped = toMarketplacePull(done, { url: lead.url });
        mapped.agent_attempted_at = lead.payload?.marketplace_pull?.agent_attempted_at ?? new Date().toISOString();
        mapped.agent_run_id = lead.runId;
        const got = await writePull(lead, mapped);
        if (got) { pulled++; console.log(`    ✓ ${lead.supplier_name} × ${lead.material_name} → ${mapped.currency ?? "USD"} ${mapped.current_price}`); }
        else console.log(`    · ${lead.supplier_name} × ${lead.material_name} → ${mapped.classification} [${done.status}]`);
      } catch (e) {
        console.log(`    · ${lead.supplier_name} × ${lead.material_name} → harvest error: ${String(e?.message ?? e).slice(0, 80)}`);
      }
    }),
  );
  return { harvested: leads.length, pulled };
}

async function pullForAccount(account, org, leads, { dryRun }) {
  const adapter = adapterForHost(account.host);
  if (!adapter?.login) return { pulled: 0, failed: 0, note: `no login adapter for ${account.host}` };
  const r = await pullLeads(leads, {
    login: (page) => adapter.login(page, { email: account.signup_email, password: account.password }),
    dryRun,
  });
  if (!dryRun) await updateAccount(account.id, { last_login_at: new Date().toISOString() });
  return r;
}

async function main() {
  const orgFilter = arg("org");
  const hostFilter = arg("host");
  const limit = Number(arg("limit")) || MAX_LEADS_PER_ACCOUNT_DEFAULT;
  const dryRun = !!arg("dry-run");
  const noLogin = !!arg("no-login");
  const agentic = !!arg("agentic");
  const allActive = !!arg("all-active");
  // Tier-2 escalation flags: after the cheap passive pass, send unresolved leads
  // to the native Browserbase agent.
  const escalate = !!arg("escalate");
  const harvest = !!arg("harvest"); // recover interrupted Tier-2 runs before doing new work
  // Wall-clock budget per run. Stagehand-per-lead makes Tier 1 ~2.4 min/lead, and
  // the scheduled-session host kills a run at ~10 min, so a long uncapped pull can't
  // finish in one session. --max-minutes makes the run stop cleanly before the cap
  // and the NEXT scheduled batch resumes at the stalest leads (see accounts.mjs order).
  // 0 = unbounded (manual runs).
  const maxMinutes = Number(arg("max-minutes")) || 0;
  const deadline = maxMinutes ? Date.now() + maxMinutes * 60000 : 0;
  // Concurrent Browserbase sessions for the no-login pass. Plan limit is 100; keep
  // headroom. >1 fans out (pullLeadsParallel); 1 = the sequential shared-session path.
  const concurrency = Math.min(Number(arg("concurrency")) || 1, 90);
  // Refresh mode: re-pull EVERY marketplace lead (not just the unresolved ones) so
  // daily prices stay current; writePull reflects changes and keeps the last-known
  // price (flagging the WHY) when a refresh can't read one.
  const refreshAll = !!arg("refresh-all");
  // Per-host concurrency cap + per-lead wall-clock timeout for the parallel pass.
  const hostCap = Number(arg("host-cap")) || 4;
  const leadTimeoutMs = (Number(arg("lead-timeout")) || 220) * 1000;
  // Session self-terminates server-side a bit AFTER the app-level lead timeout, so
  // an abandoned lead's browser is reaped rather than lingering to the 600s cap.
  process.env.BB_SESSION_TIMEOUT_SEC = String(Math.round(leadTimeoutMs / 1000) + 20);
  const agentLimit = Number(arg("agent-limit")) || 10;
  const agentId = arg("agent-id") || process.env.BROWSERBASE_AGENT_ID || undefined;
  const agentRetry = !!arg("agent-retry");
  // Which Agent-05 give-up reasons to attempt recovering. Default covers both
  // recoverable buckets (login_required false positives + JS-rendered needs_review).
  const reasons = (arg("reasons") || "login_required,needs_review")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  // No-login mode: pull login_required leads WITHOUT an account — the
  // false-positive case where the price is actually public (Agent 05 over-flags
  // generic "sign in" nav as a paywall). Ignores marketplace_accounts.
  // Scope: --org <slug>, or --all-active (every sourcing_status=active org).
  if (noLogin || agentic || harvest) {
    const skipInternal = !!arg("skip-internal");
    let orgs;
    if (allActive) orgs = await listActiveOrgs();
    else if (orgFilter) orgs = [await getOrg(orgFilter)].filter(Boolean);
    else throw new Error(`this mode requires --org <slug> or --all-active`);
    // Real/paying clients only — don't spend Browserbase budget recovering prices
    // for internal test orgs (is_internal = true). Real clients take priority.
    if (skipInternal) orgs = orgs.filter((o) => !o.is_internal);
    if (!orgs.length) throw new Error("no matching orgs");

    const results = [];
    for (const org of orgs) {
      if (deadline && Date.now() > deadline) {
        results.push({ org: org.slug, skipped: "time budget reached before start" });
        continue;
      }
      try {
        // First: recover any Tier-2 runs a prior (interrupted) run left pending.
        let hv = null;
        if (harvest) hv = await harvestAgentRuns(org, { dryRun });

        // Tier 1 passive pull (skip when this is a harvest-only run).
        let r = { pulled: 0, failed: 0, leads: 0 };
        if (noLogin || agentic) {
          let leads = await listLoginRequiredLeads(org.id, {
            reasons,
            all: refreshAll,
            ...(hostFilter ? { host: hostFilter.replace(/^www\./, "") } : {}),
          });
          leads = leads.slice(0, limit);
          console.log(`\n[${org.slug}] ${agentic ? "agentic" : "no-login"}${refreshAll ? " REFRESH-ALL" : ""} pull of up to ${leads.length} lead(s)${concurrency > 1 ? ` @concurrency=${concurrency}` : ""}${maxMinutes ? ` (≤${maxMinutes} min budget)` : ""}${dryRun ? " (dry-run)" : ""}`);
          if (leads.length) {
            const run = agentic
              ? await pullLeadsAgentic(leads, { dryRun })
              : concurrency > 1
                ? await pullLeadsParallel(leads, { concurrency, dryRun, deadline, hostCap, leadTimeoutMs })
                : await pullLeads(leads, { dryRun, deadline });
            r = { leads: leads.length, ...run };
          }
        }

        // Tier 2: escalate the leads Tier 1 left as needs_manual_pull to the native agent.
        let esc = null;
        if (escalate) esc = await escalateWithAgent(org, { agentLimit, agentId, retry: agentRetry, dryRun, hostFilter });

        results.push({ org: org.slug, ...r, ...(hv ? { harvest: hv } : {}), ...(esc ? { agent: esc } : {}) });
      } catch (e) {
        results.push({ org: org.slug, error: String(e?.message ?? e) });
      }
    }
    console.log("\n=== summary ===");
    console.log(JSON.stringify({ mode: agentic ? "agentic" : "no-login", orgs: orgs.length, results }, null, 2));
    return;
  }

  let accounts = await listAccounts({ status: "active" });
  if (hostFilter) accounts = accounts.filter((a) => a.host === hostFilter.replace(/^www\./, ""));

  const orgCache = new Map();
  const summary = [];
  for (const account of accounts) {
    let org = orgCache.get(account.org_id);
    if (!org) {
      org = await getOrg(account.org_id);
      orgCache.set(account.org_id, org);
    }
    if (orgFilter && org?.slug !== orgFilter && org?.id !== orgFilter) continue;

    const leads = (await listLoginRequiredLeads(account.org_id, { host: account.host })).slice(0, limit);
    console.log(`\n[${org?.slug ?? account.org_id} · ${account.host}] ${leads.length} gated lead(s)${dryRun ? " (dry-run)" : ""}`);
    if (!leads.length) {
      summary.push({ org: org?.slug, host: account.host, pulled: 0, failed: 0, leads: 0 });
      continue;
    }
    try {
      const r = await pullForAccount(account, org, leads, { dryRun });
      summary.push({ org: org?.slug, host: account.host, leads: leads.length, ...r });
    } catch (e) {
      const msg = String(e?.message ?? e);
      const banned = e?.name === "BanError";
      await updateAccount(account.id, banned ? { status: "banned", last_error: msg } : { last_error: msg });
      summary.push({ org: org?.slug, host: account.host, leads: leads.length, error: msg, marked: banned ? "banned" : null });
    }
  }

  console.log("\n=== summary ===");
  console.log(JSON.stringify({ accounts: accounts.length, results: summary }, null, 2));
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exitCode = 1;
});
