// Provision a gated-marketplace account for an org (Ben's feature, step 1).
//
// Semi-auto verification: we register the account with the client's purchasing
// email + a generated password via a proxied Browserbase session, then — because
// the confirm-link email lands in the client's mailbox, which we can't read —
// open a case asking a human to click it once. After that, batch.mjs logs in
// and pulls prices automatically on every run.
//
// Usage:
//   node signup.mjs --org sierra                      # host defaults to knowde.com
//   node signup.mjs --org sierra --host knowde.com
//   node signup.mjs --org sierra --email buyer@acme.com   # override purchasing email
//   node signup.mjs --org sierra --dry-run            # resolve + print, no DB write, no browser
//
// Env: OA_SUPABASE_SERVICE_ROLE_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID.

import { withRotatingSession, BanError } from "./src/session.mjs";
import { adapterForHost, generatePassword, signupIdentity } from "./src/adapters.mjs";
import { isRfqWall, runSignup } from "./src/login.mjs";
import { getOrg, getAccount, createAccount, updateAccount, openCase } from "./src/accounts.mjs";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

async function main() {
  const orgRef = arg("org");
  const host = (arg("host") || "knowde.com").replace(/^www\./, "");
  const emailOverride = arg("email");
  const dryRun = !!arg("dry-run");
  if (!orgRef) throw new Error("--org <slug|uuid> required");

  // RFQ / quote-wall / directory hosts never expose a list price even logged in,
  // so provisioning an account there is wasted — refuse up front.
  if (isRfqWall(host)) {
    console.log(JSON.stringify({ ok: false, skipped: true, reason: `${host} is an RFQ/quote wall — login yields no list price, not worth provisioning` }, null, 2));
    return;
  }

  // A per-host adapter is now OPTIONAL: with one we use its tuned selectors, and
  // without one we fall back to the generic Stagehand-driven signup (works on any
  // self-serve marketplace). So no adapter is no longer a hard stop.
  const adapter = adapterForHost(host);

  const org = await getOrg(orgRef);
  if (!org) throw new Error(`org not found: ${orgRef}`);

  const email = emailOverride || org.signup_email;
  if (!email) {
    throw new Error(
      `no purchasing email for org "${org.slug}". Set orgs.purchasing_email or pass --email. ` +
        `(Ben's flow registers with the client's real purchasing email.)`
    );
  }

  const existing = await getAccount(org.id, host);
  if (existing && ["active", "verifying", "signing_up"].includes(existing.status)) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: `account already ${existing.status}`, account: existing }, null, 2));
    return;
  }

  const password = generatePassword();
  const identity = signupIdentity({ orgName: org.name, email });

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, org: org.slug, host, email, identity, password: "•".repeat(password.length), would: "create marketplace_accounts row + Browserbase signup + open confirm-link case" }, null, 2));
    return;
  }

  // Row first (or reuse a prior failed row), so a crash mid-signup is visible.
  let account = existing
    ? await updateAccount(existing.id, { signup_email: email, password, status: "signing_up", last_error: null })
    : await createAccount({ org_id: org.id, host, slug: adapter.slug, signup_email: email, password, status: "signing_up" });

  let result;
  try {
    if (adapter?.signup) {
      // Tuned per-host adapter (raw Playwright over a rotating session).
      result = await withRotatingSession(async ({ page, viewUrl }) => {
        const r = await adapter.signup(page, { email, password, ...identity });
        r.viewUrl = viewUrl;
        if (r.outcome === "blocked") throw new BanError(r.notes); // rotate to a fresh IP
        return r;
      });
    } else {
      // Generic Stagehand signup — works on any self-serve marketplace, no adapter.
      result = await runSignup({ email, password, host, signupUrl: adapter?.signupUrl ?? null, ...identity });
    }
  } catch (e) {
    await updateAccount(account.id, { status: "failed", last_error: String(e?.message ?? e) });
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e), account_id: account.id }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (result.outcome === "already_exists") {
    await updateAccount(account.id, { status: "failed", last_error: "email already registered — needs manual login/password reset" });
    console.log(JSON.stringify({ ok: false, outcome: result.outcome, notes: result.notes, account_id: account.id }, null, 2));
    return;
  }

  if (result.outcome !== "verification_pending") {
    await updateAccount(account.id, { status: "failed", last_error: `signup outcome ${result.outcome}: ${result.notes}` });
    console.log(JSON.stringify({ ok: false, outcome: result.outcome, notes: result.notes, viewUrl: result.viewUrl, account_id: account.id }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Accepted, awaiting email confirmation → open the human "click the link" case.
  const caseId = await openCase({
    orgId: org.id,
    type: "marketplace_price_pull",
    recommended_action: `Click the account-confirmation link in the "${host}" email sent to ${email} to finish creating the sourcing login for ${org.name}. Once confirmed, the agent logs in and pulls gated prices automatically.`,
    metadata: { kind: "marketplace_signup_verify", host, signup_email: email, marketplace_account_id: account.id },
  }).catch((e) => {
    console.error("case open failed (non-fatal):", e?.message ?? e);
    return null;
  });

  account = await updateAccount(account.id, { status: "verifying", case_id: caseId });
  console.log(JSON.stringify({ ok: true, outcome: result.outcome, org: org.slug, host, email, account_id: account.id, case_id: caseId, viewUrl: result.viewUrl, next: "human clicks confirm link → account becomes usable; run batch.mjs to pull" }, null, 2));
}

main().catch((e) => {
  console.error(e?.stack ?? String(e));
  process.exitCode = 1;
});
