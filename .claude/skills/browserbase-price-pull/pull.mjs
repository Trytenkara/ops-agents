// CLI: pull pricing/tiers for a single login-gated marketplace listing.
//   node pull.mjs --url <listing_url> [--supplier "..."] [--material "..."]
// Uses a rotating proxied Browserbase session, logs in via the domain's adapter
// (if one is registered and creds are set), then extracts the price ladder.
// Prints a single JSON object to stdout (session view URLs go to stderr).
import { withRotatingSession, BanError, looksBlocked } from "./src/session.mjs";
import { adapterFor } from "./src/adapters.mjs";
import { extractPricing } from "./src/extract.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg("url");
const supplier = arg("supplier") ?? "";
const material = arg("material") ?? "";
if (!url) {
  console.error("usage: node pull.mjs --url <listing_url> [--supplier ..] [--material ..]");
  process.exit(1);
}

const adapter = adapterFor(url);

const result = await withRotatingSession(
  async ({ page, viewUrl }, attempt) => {
    console.error(`attempt ${attempt + 1} — session ${viewUrl}`);
    if (adapter) {
      const email = process.env[`${adapter.slug}_EMAIL`];
      const password = process.env[`${adapter.slug}_PASSWORD`];
      if (!email || !password) {
        return {
          classification: "login_required",
          current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [],
          notes: `no credentials for ${adapter.slug} — set ${adapter.slug}_EMAIL / ${adapter.slug}_PASSWORD in Settings -> Secrets`,
        };
      }
      await adapter.login(page, { email, password });
    }
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Let JS-heavy marketplace pages hydrate before we read them.
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 3; i++) {
      const len = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);
      if (len > 200) break;
      await page.waitForTimeout(2000);
    }
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "");
    if (looksBlocked(resp?.status(), bodyText)) throw new BanError(`blocked (http ${resp?.status()})`);
    return extractPricing({ page, supplier, material });
  },
  { maxAttempts: 3 }
).catch((e) => ({
  classification: e?.name === "BanError" ? "needs_review" : "needs_review",
  current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [],
  notes: `pull failed: ${e?.message ?? e}`,
}));

console.log(JSON.stringify(result, null, 2));
