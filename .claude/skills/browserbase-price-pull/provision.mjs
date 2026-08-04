// Auto-provision marketplace accounts for every login-gated host a real client's
// leads point at — no per-host adapter, no manual host list.
//
// For each sourcing org (real clients first): collect the DISTINCT hosts of its
// `login_required` leads, drop RFQ/quote walls (login there yields no price) and
// hosts we've already provisioned, then run the generic Stagehand signup on each
// using the org's purchasing_email + a generated password, then PROVE the account
// by logging in with it. Authenticating is the activation gate — no email
// confirmation click is involved, because storefronts sign you in on registration
// and only require confirmation to order, while we only need to read prices.
// Lifecycle: signing_up → active (login probe passed) | verifying (registered but
// login blocked, retryable) | failed. Progress is visible on the client's
// Supplier Validation → Marketplace Logins panel.
//
// Usage:
//   node provision.mjs --all-active --skip-internal            # real clients, all gated hosts
//   node provision.mjs --org california-chemicals              # one org
//   node provision.mjs --org sierra --host bulkfoods.com       # one host
//   node provision.mjs --org x --host y.com --email a+y@x.com  # alias (base email burned)
//   node provision.mjs --all-active --limit-hosts 20           # cap hosts/org this run
//   node provision.mjs --verify-existing                       # re-probe stuck `verifying` accounts
//   node provision.mjs --all-active --dry-run                  # plan only, no browser/DB
//
// Env: OA_SUPABASE_SERVICE_ROLE_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID.

import { adapterForHost, generatePassword, signupIdentity } from "./src/adapters.mjs";
import { isRfqWall, runSignup, verifyByLogin, openStagehandSession } from "./src/login.mjs";
import { withRotatingSession, BanError } from "./src/session.mjs";
import {
  getOrg,
  listActiveOrgs,
  listLoginRequiredLeads,
  getAccount,
  listAccounts,
  createAccount,
  updateAccount,
  hostOf,
} from "./src/accounts.mjs";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

// Distinct gated hosts for an org, ranked by lead volume (provision the
// highest-leverage marketplaces first).
async function gatedHostsForOrg(orgId, hostFilter) {
  const leads = await listLoginRequiredLeads(orgId, { reasons: ["login_required"] });
  const counts = new Map();
  for (const l of leads) {
    const h = hostOf(l.url);
    if (!h) continue;
    if (hostFilter && h !== hostFilter.replace(/^www\./, "")) continue;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([host, leadCount]) => ({ host, leadCount }));
}

// Provision ONE (org, host): create/refresh the row, run signup, classify,
// open a confirm-link case on acceptance. Mirrors signup.mjs but callable in a
// loop. Returns a status object for the run summary.
async function provisionOne(org, host, { dryRun, emailOverride = null, retry = false }) {
  if (isRfqWall(host)) return { host, status: "skipped_rfq_wall" };

  // An override is for the case where the org's base address is already burned
  // on this host (registered under a password we no longer hold, and password
  // reset needs a mailbox we deliberately don't read). A plus-alias of the same
  // real mailbox gets a clean registration.
  const email = emailOverride ?? org.signup_email;
  if (!email) return { host, status: "skipped_no_email" };

  const existing = await getAccount(org.id, host);
  // `signing_up` is also what a crashed run leaves behind, so --retry lets a
  // stuck row be driven again without hand-editing it back to failed.
  const holdStatuses = retry ? ["active", "verifying"] : ["active", "verifying", "signing_up"];
  if (existing && holdStatuses.includes(existing.status)) {
    return { host, status: `skipped_already_${existing.status}`, account_id: existing.id };
  }

  const adapter = adapterForHost(host);
  // Reuse the stored password on a retry. An earlier attempt may have actually
  // created the account before we failed to confirm it; rotating the password
  // here would throw away the only credentials that can ever open it, since
  // password reset needs a mailbox we don't read.
  const password = existing?.password && existing.signup_email === email ? existing.password : generatePassword();
  const identity = signupIdentity({ orgName: org.name, email });

  if (dryRun) return { host, status: "would_provision", email, via: adapter?.signup ? "adapter" : "stagehand" };

  let account = existing
    ? await updateAccount(existing.id, { signup_email: email, password, status: "signing_up", last_error: null })
    : await createAccount({ org_id: org.id, host, slug: adapter?.slug ?? host.replace(/[^a-z0-9]+/gi, "_").toUpperCase(), signup_email: email, password, status: "signing_up" });

  let result;
  try {
    if (adapter?.signup) {
      result = await withRotatingSession(async ({ page, viewUrl }) => {
        const r = await adapter.signup(page, { email, password, ...identity });
        r.viewUrl = viewUrl;
        if (r.outcome === "blocked") throw new BanError(r.notes);
        return r;
      });
    } else {
      result = await runSignup({ email, password, host, signupUrl: adapter?.signupUrl ?? null, ...identity });
    }
  } catch (e) {
    await updateAccount(account.id, { status: "failed", last_error: String(e?.message ?? e).slice(0, 300) });
    return { host, status: "failed", error: String(e?.message ?? e).slice(0, 120), account_id: account.id };
  }

  if (result.outcome === "already_exists") {
    await updateAccount(account.id, { status: "failed", last_error: "email already registered — needs manual login/reset" });
    return { host, status: "already_exists", account_id: account.id };
  }
  // The login probe is the activation gate — an account we can authenticate
  // with is usable for scraping whether or not its confirmation email was ever
  // clicked, so nothing here waits on a mailbox.
  if (result.outcome === "active") {
    await updateAccount(account.id, {
      status: "active",
      verified_at: new Date().toISOString(),
      confirmed_via: `login_probe:${result.authenticated_via ?? "login"}`,
      last_error: null,
    });
    return { host, status: "active", account_id: account.id, viewUrl: result.viewUrl };
  }
  if (result.outcome !== "verification_pending") {
    await updateAccount(account.id, { status: "failed", last_error: `signup outcome ${result.outcome}: ${result.notes ?? ""}`.slice(0, 300) });
    return { host, status: result.outcome, notes: result.notes, viewUrl: result.viewUrl, account_id: account.id };
  }

  // Registered but we could not authenticate yet — the site really does hold the
  // account until it is confirmed, or approves B2B buyers by hand. Keep the row
  // so --verify-existing can retry the login later.
  await updateAccount(account.id, { status: "verifying", last_error: `registered but login probe failed: ${result.notes ?? ""}`.slice(0, 300) });
  return { host, status: "verifying", account_id: account.id, viewUrl: result.viewUrl };
}

// Re-run the login probe against accounts that never activated. Flips any row
// whose credentials now authenticate to `active` so the scraper picks it up.
async function verifyExisting({ orgFilter, dryRun }) {
  const pending = (await listAccounts({ status: "verifying" })).filter((a) => !orgFilter || a.org_id === orgFilter.id);
  console.log(`\n[verify-existing] ${pending.length} account(s) in verifying`);
  const out = [];
  for (const acct of pending) {
    if (dryRun) {
      out.push({ host: acct.host, status: "would_verify" });
      console.log(`  · ${acct.host} → would probe`);
      continue;
    }
    let r;
    const s = await openStagehandSession().catch((e) => ({ error: e }));
    if (s.error) {
      r = { ok: false, notes: String(s.error?.message ?? s.error).slice(0, 160) };
    } else {
      try {
        r = await verifyByLogin(s.page, { email: acct.signup_email, password: acct.password, host: acct.host, stagehand: s.stagehand });
      } catch (e) {
        r = { ok: false, notes: String(e?.message ?? e).slice(0, 160) };
      } finally {
        await s.close();
      }
    }
    if (r.ok) {
      await updateAccount(acct.id, { status: "active", verified_at: new Date().toISOString(), confirmed_via: `login_probe:${r.via}`, last_error: null });
    } else {
      await updateAccount(acct.id, { last_error: `login probe failed: ${r.notes}`.slice(0, 300) });
    }
    out.push({ host: acct.host, status: r.ok ? "active" : "still_verifying", notes: r.notes });
    console.log(`  ${r.ok ? "→" : "·"} ${acct.host} → ${r.ok ? "active" : "still verifying"}: ${r.notes}`);
  }
  return out;
}

async function main() {
  const orgFilter = arg("org");
  const hostFilter = arg("host");
  const allActive = !!arg("all-active");
  const skipInternal = !!arg("skip-internal");
  const dryRun = !!arg("dry-run");
  const limitHosts = Number(arg("limit-hosts")) || 0;
  const emailOverride = typeof arg("email") === "string" ? arg("email") : null;
  const retry = !!arg("retry");
  if (emailOverride && !hostFilter) throw new Error("--email requires --host (an override is per-host, not fleet-wide)");

  if (arg("verify-existing")) {
    const org = orgFilter ? await getOrg(orgFilter) : null;
    const results = await verifyExisting({ orgFilter: org, dryRun });
    console.log("\n=== verify summary ===");
    console.log(JSON.stringify({ verified: results }, null, 2));
    return;
  }

  let orgs;
  if (allActive) orgs = await listActiveOrgs();
  else if (orgFilter) orgs = [await getOrg(orgFilter)].filter(Boolean);
  else throw new Error("provision requires --org <slug> or --all-active");
  if (skipInternal) orgs = orgs.filter((o) => !o.is_internal);
  if (!orgs.length) throw new Error("no matching orgs");

  const summary = [];
  for (const orgLite of orgs) {
    // listActiveOrgs() omits purchasing_email — resolve the full row so signup
    // registers with the client's real purchasing identity.
    const org = (await getOrg(orgLite.id)) ?? orgLite;
    let hosts = await gatedHostsForOrg(org.id, hostFilter);
    // Provision genuine self-serve marketplaces; RFQ walls are recorded as skipped
    // (not silently dropped) so the summary shows what was intentionally left out.
    const provisionable = hosts.filter((h) => !isRfqWall(h.host));
    const rfqSkipped = hosts.filter((h) => isRfqWall(h.host)).map((h) => h.host);
    const targets = limitHosts ? provisionable.slice(0, limitHosts) : provisionable;

    console.log(`\n[${org.slug}] ${org.signup_email ? `email=${org.signup_email}` : "NO signup email (set purchasing_email or tenkara_email_address)"} — ${targets.length} host(s) to provision, ${rfqSkipped.length} RFQ wall(s) skipped${dryRun ? " (dry-run)" : ""}`);

    const results = [];
    for (const { host, leadCount } of targets) {
      const r = await provisionOne(org, host, { dryRun, emailOverride, retry });
      results.push({ ...r, leadCount });
      console.log(`  ${r.status.startsWith("skipped") || r.status === "failed" || r.status === "already_exists" ? "·" : "→"} ${host} (${leadCount} lead${leadCount > 1 ? "s" : ""}) → ${r.status}${r.viewUrl ? `  ${r.viewUrl}` : ""}${r.error ? `  ${r.error}` : ""}`);
    }
    summary.push({ org: org.slug, signup_email: org.signup_email ?? null, provisioned: results, rfq_skipped: rfqSkipped });
  }

  console.log("\n=== provision summary ===");
  console.log(JSON.stringify({ orgs: orgs.length, dryRun, summary }, null, 2));
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exitCode = 1;
});
