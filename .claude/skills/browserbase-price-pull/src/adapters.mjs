// Per-marketplace login adapters. Credentials are read from env as
// <SLUG>_EMAIL / <SLUG>_PASSWORD (e.g. KNOWDE_EMAIL / KNOWDE_PASSWORD), added
// under the agent's Settings -> Secrets. Add an entry here as each marketplace
// account is provisioned. Selectors are best-effort and easy to tweak per site.
export const ADAPTERS = {
  "knowde.com": {
    slug: "KNOWDE",
    loginUrl: "https://www.knowde.com/sign_in",
    signupUrl: "https://www.knowde.com/sign_up",
    async login(page, { email, password }) {
      await page.goto("https://www.knowde.com/sign_in", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.fill('input[type="email"], input[name="email"], input[name="user[email]"]', email);
      await page.fill('input[type="password"], input[name="password"], input[name="user[password]"]', password);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Sign in")'),
        page.waitForLoadState("networkidle").catch(() => {}),
      ]);
    },
    // Best-effort registration. Selectors are intentionally loose (multiple
    // fallbacks) because signup forms change and vary by A/B bucket — the pilot
    // dry-run surfaces the real DOM and we tighten from there. Returns a
    // SignupResult (see signupResult()).
    async signup(page, { email, password, firstName, lastName, company }) {
      await page.goto("https://www.knowde.com/sign_up", { waitUntil: "domcontentloaded", timeout: 60000 });
      const tryFill = async (selectors, value) => {
        for (const s of selectors) {
          const el = page.locator(s).first();
          if (await el.count().catch(() => 0)) {
            await el.fill(value).catch(() => {});
            return true;
          }
        }
        return false;
      };
      await tryFill(['input[name="first_name"]', 'input[name="user[first_name]"]', 'input[autocomplete="given-name"]', 'input[placeholder*="First" i]'], firstName);
      await tryFill(['input[name="last_name"]', 'input[name="user[last_name]"]', 'input[autocomplete="family-name"]', 'input[placeholder*="Last" i]'], lastName);
      await tryFill(['input[name="company"]', 'input[name="user[company]"]', 'input[placeholder*="Company" i]', 'input[placeholder*="Organization" i]'], company);
      await tryFill(['input[type="email"]', 'input[name="email"]', 'input[name="user[email]"]'], email);
      await tryFill(['input[type="password"]', 'input[name="password"]', 'input[name="user[password]"]'], password);
      await tryFill(['input[name="password_confirmation"]', 'input[name="user[password_confirmation]"]', 'input[placeholder*="Confirm" i]'], password);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Sign up"), button:has-text("Create"), button:has-text("Register")').catch(() => {}),
        page.waitForLoadState("networkidle").catch(() => {}),
      ]);
      return classifySignup(page);
    },
  },
  "ingredientsonline.com": {
    slug: "INGREDIENTSONLINE",
    loginUrl: "https://www.ingredientsonline.com/login",
    async login(page, { email, password }) {
      await page.goto("https://www.ingredientsonline.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.fill('input[type="email"], input[name="email"], input[name="username"]', email);
      await page.fill('input[type="password"], input[name="password"]', password);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")'),
        page.waitForLoadState("networkidle").catch(() => {}),
      ]);
    },
  },
};

export function adapterFor(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return ADAPTERS[host] ?? null;
  } catch {
    return null;
  }
}

export function adapterForHost(host) {
  return ADAPTERS[host?.replace(/^www\./, "")] ?? null;
}

// Look at the post-submit page and decide what happened. We can't read the
// client's mailbox (semi-auto verification), so the win condition here is
// "account was accepted and is awaiting email confirmation" — not "logged in".
export async function classifySignup(page) {
  const url = page.url();
  const body = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).toLowerCase();
  const has = (...res) => res.some((re) => re.test(body));
  if (has(/verify your email/i, /confirmation (email|link)/i, /check your (inbox|email)/i, /confirm your (email|account)/i, /we sent/i)) {
    return signupResult("verification_pending", url, "signup accepted; confirmation email sent");
  }
  if (has(/already (registered|have an account|taken|exists)/i, /email has already/i)) {
    return signupResult("already_exists", url, "email already registered");
  }
  if (has(/captcha/i, /are you a robot/i, /unusual traffic/i, /verify you are human/i)) {
    return signupResult("blocked", url, "bot/captcha wall during signup");
  }
  if (has(/thank you/i, /welcome/i) || /\/(dashboard|account|onboarding)/.test(url)) {
    return signupResult("verification_pending", url, "signup appears accepted");
  }
  return signupResult("unknown", url, "could not classify signup outcome — inspect screenshot");
}

function signupResult(outcome, url, notes) {
  // outcome: verification_pending | already_exists | blocked | unknown
  return { outcome, url, notes };
}

// Generate a password that clears typical marketplace complexity rules
// (>=12 chars, upper+lower+digit+symbol). Uses the pool of hostnames' name to
// keep it human-typeable-ish but random.
export function generatePassword(len = 16) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digit = "23456789";
  const sym = "!@#$%^&*-_";
  const all = upper + lower + digit + sym;
  const pick = (set) => set[Math.floor(cryptoFloat() * set.length)];
  const chars = [pick(upper), pick(lower), pick(digit), pick(sym)];
  while (chars.length < len) chars.push(pick(all));
  // Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(cryptoFloat() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function cryptoFloat() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

// Derive first/last/company for a signup form from the org name + email when we
// don't have explicit contact fields. Company = org name; name split from the
// email local-part (first.last@) or a neutral default.
export function signupIdentity({ orgName, email }) {
  const local = (email.split("@")[0] || "").replace(/\+.*/, "");
  const parts = local.split(/[._-]+/).filter(Boolean);
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const firstName = cap(parts[0] || "Purchasing");
  const lastName = cap(parts[1] || "Team");
  return { firstName, lastName, company: orgName || "Purchasing" };
}
