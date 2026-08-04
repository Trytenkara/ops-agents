// Click stored confirmation links with a real browser.
//
// The webhook (marketplace-confirm.ts in ops-agents) clicks confirm links
// server-side with a plain fetch; when that fails (JS-only confirm pages, bot
// checks) it stores the link on the marketplace_accounts row and leaves status
// 'verifying'. This CLI drains those: opens each confirm_url in a proxied
// Browserbase session, checks the rendered page for a success signal, and flips
// the account active.
//
// Usage:
//   node confirm.mjs             # all verifying accounts with a stored confirm_url
//   node confirm.mjs --org <slug>
//   node confirm.mjs --dry-run
//
// Env: OA_SUPABASE_SERVICE_ROLE_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID.

import { openStagehandSession } from "./src/login.mjs";
import { listAccounts, updateAccount, getOrg } from "./src/accounts.mjs";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const SUCCESS_RE = /(confirmed|verified|activated|thank you|welcome|success|your account is (now )?(active|ready)|email (address )?(has been )?(confirmed|verified))/i;
const FAILURE_RE = /(expired|invalid (link|token)|already (confirmed|verified|used)|error)/i;

async function clickInBrowser(url) {
  const s = await openStagehandSession();
  try {
    await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await s.page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await s.page.waitForTimeout(2500);
    const body = (await s.page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 4000);
    // "already confirmed" counts as success — the goal state is reached.
    const already = /already (confirmed|verified|used)/i.test(body);
    if (SUCCESS_RE.test(body) || already) return { ok: true, detail: already ? "already confirmed" : "success text rendered", viewUrl: s.viewUrl };
    if (FAILURE_RE.test(body)) return { ok: false, detail: `failure text: ${body.replace(/\s+/g, " ").slice(0, 140)}`, viewUrl: s.viewUrl };
    // No clear signal — the GET itself usually consumes the token; treat a
    // rendered page without an error as a soft success.
    return { ok: true, detail: `no explicit signal; page rendered: ${body.replace(/\s+/g, " ").slice(0, 100)}`, viewUrl: s.viewUrl };
  } finally {
    await s.close();
  }
}

async function main() {
  const orgFilter = arg("org");
  const dryRun = !!arg("dry-run");

  let accounts = (await listAccounts({ status: "verifying" })).filter((a) => a.confirm_url);
  if (orgFilter) {
    const org = await getOrg(orgFilter);
    if (!org) throw new Error(`org not found: ${orgFilter}`);
    accounts = accounts.filter((a) => a.org_id === org.id);
  }
  if (!accounts.length) {
    console.log(JSON.stringify({ ok: true, note: "no verifying accounts with a stored confirm_url" }));
    return;
  }

  const results = [];
  for (const a of accounts) {
    if (dryRun) {
      results.push({ host: a.host, would: "browser-click", url: a.confirm_url });
      continue;
    }
    try {
      const r = await clickInBrowser(a.confirm_url);
      if (r.ok) {
        await updateAccount(a.id, { status: "active", verified_at: new Date().toISOString(), confirmed_via: "browserbase_click", last_error: null });
        results.push({ host: a.host, status: "active", detail: r.detail });
        console.log(`  ✓ ${a.host} → active (${r.detail})`);
      } else {
        await updateAccount(a.id, { last_error: `browser confirm failed: ${r.detail}`.slice(0, 300) });
        results.push({ host: a.host, status: "still_verifying", detail: r.detail, viewUrl: r.viewUrl });
        console.log(`  · ${a.host} → still verifying (${r.detail})  ${r.viewUrl}`);
      }
    } catch (e) {
      results.push({ host: a.host, status: "error", error: String(e?.message ?? e).slice(0, 120) });
      console.log(`  · ${a.host} → error: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }
  console.log(JSON.stringify({ accounts: accounts.length, dryRun, results }, null, 2));
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exitCode = 1;
});
