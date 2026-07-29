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
import { listAccounts, getOrg, listActiveOrgs, listLoginRequiredLeads, writePull, updateAccount } from "./src/accounts.mjs";

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

// Pull a set of leads in one proxied (rotating) session. When `login` is
// provided we authenticate first (gated sites); otherwise we fetch the page
// directly — the false-positive case where Agent 05 flagged login_required but
// the price is actually public. Both paths render JS (Browserbase) and extract
// with the same model, and re-classify still-walled pages as needs_manual_pull.
async function pullLeads(leads, { login, dryRun } = {}) {
  if (dryRun) return { pulled: 0, failed: 0, note: `would pull ${leads.length} lead(s)` };

  const done = new Set();       // lead ids already written this run — survive session rotation
  let pulled = 0;
  let failed = 0;

  const banCount = new Map(); // per-lead 403/429/503 attempts — survives session rotation
  await withRotatingSession(async ({ page }) => {
    if (login) await login(page);

    for (const lead of leads) {
      if (done.has(lead.id)) continue;
      try {
        const resp = await page.goto(lead.url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
        const status = resp?.status?.() ?? 0;
        // HTTP 403/429/503 = an IP block. Give the lead 2 fresh-IP attempts, then
        // flag JUST this lead and continue — one host that blocks our proxy range
        // must not abort the leads sitting on every other host in the batch.
        if (looksBlockedStatus(status)) {
          const n = (banCount.get(lead.id) ?? 0) + 1;
          banCount.set(lead.id, n);
          if (n < 2) throw new BanError(`blocked (status ${status})`); // rotate IP, retry this lead
          await writePull(lead, { classification: "login_required", notes: `Host returns ${status} to proxy IPs after ${n} attempts; not publicly pullable.` });
          done.add(lead.id);
          failed++;
          console.log(`  · ${lead.supplier_name} × ${lead.material_name} → login_required (host blocks proxy, status ${status})`);
          await sleep(jitter());
          continue;
        }
        // Let JS-heavy marketplace pages hydrate before we read them, otherwise the
        // price widget hasn't rendered yet and extraction falsely returns needs_review.
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        for (let i = 0; i < 3; i++) {
          const len = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);
          if (len > 200) break;
          await page.waitForTimeout(2000);
        }
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "");
        // Body-text block on a 200 = a per-page wall/bot-check for THIS listing, not
        // an IP ban. Flag just this lead and keep going — never abort the whole run.
        if (looksBlockedBody(bodyText)) {
          await writePull(lead, { classification: "login_required", notes: "Page-level block/bot-check (no IP ban); price not publicly renderable." });
          done.add(lead.id);
          failed++;
          console.log(`  · ${lead.supplier_name} × ${lead.material_name} → login_required (page-level block)`);
          await sleep(jitter());
          continue;
        }

        const result = await extractPricing({ page, supplier: lead.supplier_name, material: lead.material_name });
        const gotPrice = await writePull(lead, result);
        done.add(lead.id);
        if (gotPrice) {
          pulled++;
          console.log(`  ✓ ${lead.supplier_name} × ${lead.material_name} → ${result.currency ?? "USD"} ${result.current_price}`);
        } else {
          failed++;
          console.log(`  · ${lead.supplier_name} × ${lead.material_name} → ${result.classification} (${result.notes ?? ""})`);
        }
        await sleep(jitter());
      } catch (e) {
        if (e?.name === "BanError") throw e;   // real IP ban → rotate to a fresh IP
        if (isSessionDead(e)) throw new BanError("session died mid-loop"); // rotate + resume (done-set keeps progress)
        // Per-lead transient error (extract failure, nav timeout on one URL) →
        // flag just this lead and keep the run going.
        await writePull(lead, { classification: "needs_review", notes: `pull error: ${String(e?.message ?? e).slice(0, 180)}` });
        done.add(lead.id);
        failed++;
        console.log(`  · ${lead.supplier_name} × ${lead.material_name} → needs_review (error: ${String(e?.message ?? e).slice(0, 80)})`);
        await sleep(jitter());
      }
    }
  }, { maxAttempts: 6 });

  return { pulled, failed };
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
  const allActive = !!arg("all-active");
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
  if (noLogin) {
    const skipInternal = !!arg("skip-internal");
    let orgs;
    if (allActive) orgs = await listActiveOrgs();
    else if (orgFilter) orgs = [await getOrg(orgFilter)].filter(Boolean);
    else throw new Error("--no-login requires --org <slug> or --all-active");
    // Real/paying clients only — don't spend Browserbase budget recovering prices
    // for internal test orgs (is_internal = true). Real clients take priority.
    if (skipInternal) orgs = orgs.filter((o) => !o.is_internal);
    if (!orgs.length) throw new Error("no matching orgs");

    const results = [];
    for (const org of orgs) {
      let leads = await listLoginRequiredLeads(org.id, {
        reasons,
        ...(hostFilter ? { host: hostFilter.replace(/^www\./, "") } : {}),
      });
      leads = leads.slice(0, limit);
      console.log(`\n[${org.slug}] no-login pull of ${leads.length} lead(s)${dryRun ? " (dry-run)" : ""}`);
      if (!leads.length) { results.push({ org: org.slug, leads: 0, pulled: 0, failed: 0 }); continue; }
      try {
        const r = await pullLeads(leads, { dryRun });
        results.push({ org: org.slug, leads: leads.length, ...r });
      } catch (e) {
        results.push({ org: org.slug, leads: leads.length, error: String(e?.message ?? e) });
      }
    }
    console.log("\n=== summary ===");
    console.log(JSON.stringify({ mode: "no-login", orgs: orgs.length, results }, null, 2));
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
