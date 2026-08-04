// Generic, site-agnostic marketplace LOGIN and SIGNUP driven by Stagehand.
//
// The per-site adapters in adapters.mjs each need hand-written Playwright
// selectors. That does not scale to the ~80 distinct login-gated hosts the fleet
// surfaces. This module instead drives login/signup the way a person would —
// deterministic generic selectors FIRST (fast, no LLM), then a Stagehand agent
// fallback for odd multi-step flows — so ONE routine works on any marketplace
// given credentials. No per-host code required.
//
// Division of labor mirrors agentic.mjs: the LLM agent DRIVES (finds the login
// link, fills a weird form, clicks submit) but we never trust it to read prices;
// price extraction stays in extract.mjs.

import { z } from "zod";
import { Stagehand } from "@browserbasehq/stagehand";

const NAV_MODEL = process.env.BROWSERBASE_STAGEHAND_MODEL || "auto";

// Open a fresh proxied Stagehand session (same stealth/proxy config as
// agentic.mjs). Returns {stagehand, page, viewUrl, close}. Used by the signup
// runner so provisioning drives the agent through varied registration forms.
export async function openStagehandSession() {
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    model: NAV_MODEL,
    verbose: 0,
    logger: (line) => {
      try {
        console.error("[sh]", typeof line === "string" ? line : line?.message ?? JSON.stringify(line));
      } catch {
        /* ignore */
      }
    },
    browserbaseSessionCreateParams: {
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      proxies: true,
      timeout: Number(process.env.BB_SESSION_TIMEOUT_SEC) || 300,
      browserSettings: { solveCaptchas: true, viewport: { width: 1288, height: 711 } },
    },
  });
  await stagehand.init();
  const viewUrl = `https://browserbase.com/sessions/${stagehand.sessionId}`;
  const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
  return { stagehand, page, viewUrl, sessionId: stagehand.sessionId, close: () => stagehand.close().catch(() => {}) };
}

// Provision an account end-to-end in one Stagehand session: agent-driven signup
// on any host, then PROVE the account works by authenticating with it. Returns
// { outcome, url, notes, viewUrl }.
//
// The activation gate is the login probe, NOT an email confirmation click: most
// storefronts authenticate you the moment you register (or let you log in right
// away) and only require confirmation to place an order — and we just want to
// read prices. Outcome `active` means "we logged in and saw the account", which
// is the only claim the scraper needs.
export async function runSignup({ email, password, firstName, lastName, company, host, signupUrl }) {
  const s = await openStagehandSession();
  try {
    const onStep = (e) => console.error(`[signup:${host}]`, e?.step, "-", e?.action);
    const res = await genericSignup(s.page, { email, password, firstName, lastName, company, host, signupUrl, stagehand: s.stagehand, onStep });
    if (["blocked", "no_form"].includes(res.outcome)) return { ...res, viewUrl: s.viewUrl };

    const probe = await verifyByLogin(s.page, { email, password, host, stagehand: s.stagehand, onStep });
    if (probe.ok) {
      return { ...res, outcome: "active", authenticated_via: probe.via, notes: `${res.outcome} → login probe OK (${probe.notes})`, viewUrl: s.viewUrl };
    }
    return { ...res, notes: `${res.notes} · login probe failed: ${probe.notes}`, viewUrl: s.viewUrl };
  } finally {
    await s.close();
  }
}

// Prove credentials work: check whether the current session is already
// authenticated (registration usually signs you straight in), and if not, log
// in explicitly and re-probe. Used both right after signup and to re-test
// accounts stuck awaiting an email confirmation.
export async function verifyByLogin(page, { email, password, host, stagehand = null, onStep = null } = {}) {
  let probe = await probeAuthenticated(page, host);
  if (probe.ok) return { ok: true, via: "signup_session", notes: probe.notes };

  const li = await genericLogin(page, { email, password, host, stagehand, onStep }).catch((e) => ({ ok: false, notes: String(e?.message ?? e).slice(0, 160) }));
  probe = await probeAuthenticated(page, host);
  if (probe.ok) return { ok: true, via: "login", notes: probe.notes };
  return { ok: false, via: null, notes: li.ok ? `login looked ok but no account page confirmed it · ${probe.notes}` : li.notes };
}

// ---------------------------------------------------------------------------
// RFQ / quote-wall / directory hosts. Logging in here yields NO list price —
// only a "Request a Quote" / "Contact supplier" form (verified for knowde,
// tridge). Provisioning an account + logging in is wasted spend, so the
// auto-provision and auto-login paths SKIP these and leave the lead flagged.
// Matched by hostname suffix so `skyechem.en.made-in-china.com` also matches.
// ---------------------------------------------------------------------------
export const RFQ_WALL_HOSTS = [
  "knowde.com",
  "tridge.com",
  "alibaba.com",
  "tradeindia.com",
  "indiamart.com",
  "made-in-china.com",
  "globalsources.com",
  "globaltradeplaza.com",
  "globy.com",
  "pharmaoffer.com",
  "echemi.com",
  "ulprospector.com",
  "specialchem.com",
  "dkshdiscover.com",
  "thomasnet.com",
  "azelis.com",
  "ingredientsbazar.com",
  "faire.com",
  "univarsolutions.com",
  "usetorg.com",
];

export function isRfqWall(host) {
  const h = (host || "").replace(/^www\./, "").toLowerCase();
  return RFQ_WALL_HOSTS.some((w) => h === w || h.endsWith("." + w));
}

// Common login-page paths tried in order when we don't have an explicit URL and
// can't find a "Sign in" link on the landing page.
const LOGIN_PATHS = ["/login", "/sign_in", "/signin", "/account/login", "/customer/account/login", "/users/sign_in", "/my-account", "/account"];
const SIGNUP_PATHS = [
  "/register",
  "/sign_up",
  "/signup",
  "/account/register", // Shopify
  "/customer/account/create/", // Magento
  "/login.php?action=create_account", // BigCommerce
  "/my-account/", // WooCommerce (register block on the account page)
  "/users/sign_up",
  "/create-account",
  "/registration",
  "/join",
];

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[name="login"]',
  'input[name="user[email]"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[id*="email" i]',
  'input[name*="email" i]',
  'input[placeholder*="email" i]',
];
const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name="user[password]"]',
  'input[autocomplete="current-password"]',
  'input[id*="pass" i]',
  'input[placeholder*="password" i]',
];
const SUBMIT_TEXT = ["Sign in", "Log in", "Login", "Log In", "Sign In", "Continue", "Submit"];

// Count elements that are actually rendered. Playwright's `:visible` pseudo-class
// is NOT supported by the Stagehand page wrapper's locator engine: it matches
// nothing and reports 0, silently. Every "is a password field on screen?" check
// was therefore blind, which both aborted good signups (form declared absent)
// and false-passed the login probe (login form declared absent). Measure in the
// DOM instead.
async function countRendered(page, selector) {
  return await page
    .evaluate((sel) => {
      return [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return false;
        for (let n = el; n; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
        }
        return true;
      }).length;
    }, selector)
    .catch(() => 0);
}

// Click a button by CSS selector or by its visible label, in the DOM.
// `button:has-text("…")` is Playwright-only syntax that the Stagehand locator
// engine cannot compile: it threw ElementNotFound on buttons that were plainly
// on the page, so every text-matched submit silently did nothing while the form
// sat there filled. `scope` may be a CSS selector or "password-form" to target
// the form that owns the password field (keeps us off the newsletter button).
async function clickInPage(page, { scope = "", selectors = [], texts = [] }) {
  return await page
    .evaluate(
      ({ scope, selectors, texts }) => {
        let root = document;
        if (scope === "password-form") {
          root = [...document.querySelectorAll("form")].find((f) => f.querySelector('input[type="password"]')) ?? document;
        } else if (scope) {
          root = document.querySelector(scope) ?? document;
        }
        const shown = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        };
        for (const s of selectors) {
          const el = [...root.querySelectorAll(s)].find(shown);
          if (el) {
            el.click();
            return `sel:${s}`;
          }
        }
        const cands = [...root.querySelectorAll('button, input[type="submit"], a[role="button"]')].filter(shown);
        const label = (e) => (e.innerText || e.value || "").replace(/\s+/g, " ").trim().toLowerCase();
        for (const t of texts) {
          const want = t.toLowerCase();
          const el = cands.find((e) => label(e) === want) ?? cands.find((e) => label(e).includes(want));
          if (el) {
            el.click();
            return `text:${t}`;
          }
        }
        // Nothing clickable matched, but a real form is sitting there filled.
        if (root !== document && typeof root.requestSubmit === "function") {
          root.requestSubmit();
          return "requestSubmit";
        }
        return null;
      },
      { scope, selectors, texts }
    )
    .catch(() => null);
}

// Set a field's value in the DOM. Needed because locator.fill() refuses fields
// it considers unreachable — a cookie-consent overlay covering the form is enough
// to make it report "element not found" on inputs that are right there, which is
// how ingredientsonline's login silently submitted empty and read as bad
// credentials. Uses the native value setter so React/Vue-controlled inputs see it.
async function fillInPage(page, selector, value, scope = "") {
  return await page
    .evaluate(
      ({ sel, v, scope }) => {
        const root = scope ? (document.querySelector(scope) ?? document) : document;
        const el = [...root.querySelectorAll(sel)].find((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        });
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return el.value === v;
      },
      { sel: selector, v: value, scope }
    )
    .catch(() => false);
}

// Fill the first selector that matches, verifying the value actually landed.
// The locator path is tried first (it handles shadow DOM), then the DOM path.
async function fillField(page, selector, value, scope = "") {
  const full = scope ? `${scope} ${selector}` : selector;
  await page
    .locator(full)
    .first()
    .fill(value)
    .catch(() => {});
  const landed = await page
    .evaluate(
      ({ sel, v }) => [...document.querySelectorAll(sel)].some((e) => e.value === v),
      { sel: full, v: value }
    )
    .catch(() => false);
  if (landed) return true;
  return await fillInPage(page, selector, value, scope);
}

async function tryFill(page, selectors, value) {
  for (const s of selectors) {
    if (await fillField(page, s, value)) return true;
  }
  return false;
}

async function clickSubmit(page) {
  const hit = await clickInPage(page, {
    scope: "password-form",
    selectors: ['button[type="submit"]', 'input[type="submit"]'],
    texts: SUBMIT_TEXT,
  });
  return !!hit;
}

// Heuristic: are we authenticated now? A logged-in page usually exposes a
// sign-out / account control and no longer shows a password field. Never
// definitive, but good enough to record account.status and to avoid retrying a
// login that already worked.
export async function looksLoggedIn(page) {
  const body = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).toLowerCase();
  const hasAuthedMarker = /(sign out|log out|logout|my account|account settings|my orders|hello,|welcome back|dashboard)/i.test(body);
  const hasError = /(incorrect|invalid|wrong password|couldn't find|does not match|try again|unable to log)/i.test(body);
  const stillHasPassword = (await countRendered(page, 'input[type="password"]')) > 0;
  if (hasError) return { ok: false, reason: "login form returned an error (bad credentials or extra step)" };
  if (hasAuthedMarker && !stillHasPassword) return { ok: true, reason: "authenticated markers present, no password field" };
  if (!stillHasPassword) return { ok: true, reason: "password field gone after submit (probably logged in)" };
  return { ok: false, reason: "still showing a login form after submit" };
}

// Account pages that only render for an authenticated session. Anonymous
// visitors get redirected to a login form, which is exactly the signal we read.
const ACCOUNT_PATHS = ["/account", "/my-account", "/customer/account", "/account/dashboard", "/my-account/", "/users/edit"];
const AUTHED_MARKER = /(sign out|log out|logout|my orders|order history|account details|account dashboard|address book|welcome back)/i;

// Is this session ACTUALLY authenticated? Stricter than looksLoggedIn: navigate
// to an account-only page and require an authenticated marker with no login
// form. This is what lets us treat "we can log in and see the account" as the
// activation signal instead of an email confirmation click.
export async function probeAuthenticated(page, host) {
  for (const p of ACCOUNT_PATHS) {
    try {
      const resp = await page.goto(`https://www.${host}${p}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      if ((resp?.status?.() ?? 0) >= 400) continue;
      await page.waitForTimeout(900);
      if ((await countRendered(page, 'input[type="password"]')) > 0) continue;
      // Read the CONTENT area, not the chrome. Site-wide navigation and footers
      // carry "My orders" / "Sign out" links for anonymous visitors too, so
      // testing document.body passes on any page at all — including a 404, which
      // is what /account returns on most Magento stores. The status check above
      // does not save us: the Stagehand goto wrapper often hands back no response
      // object, so a soft 404 arrives here looking like a 200.
      const view = await page
        .evaluate(() => {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('header, footer, [class*="header" i], [class*="footer" i]').forEach((n) => n.remove());
          return {
            main: clone.innerText ?? "",
            full: document.body.innerText ?? "",
            url: location.href,
            // A sign-out control is the one thing an anonymous page never has,
            // and a visible sign-in/register control is the one thing an
            // authenticated page never has.
            signOut: [...document.querySelectorAll("a[href]")].some((a) => /log[-_]?out|sign[-_]?out/i.test(a.getAttribute("href") ?? "")),
            signIn: [...document.querySelectorAll("a, button")].some((el) => {
              const r = el.getBoundingClientRect();
              if (r.width <= 1 || r.height <= 1) return false;
              return /^(sign in|log in|login|sign up|sign up for free|register|create an account)$/i.test((el.innerText ?? "").replace(/\s+/g, " ").trim());
            }),
          };
        })
        .catch(() => null);
      if (!view) continue;
      if (/404|page not found|can'?t find what you'?re looking for/i.test(view.full)) continue;
      if (/\/(login|sign-?in)/i.test(view.url)) continue;
      if (view.signOut) return { ok: true, via: p, notes: `authenticated account page at ${p} (sign-out link present)` };
      // The text-marker branch alone false-passes: ingredientsonline's /my-account
      // renders marker words for anonymous visitors while its header still offers
      // "Sign In" / "Sign Up for Free". A sign-in control outranks any marker.
      if (!view.signIn && AUTHED_MARKER.test(view.main)) return { ok: true, via: p, notes: `authenticated account page at ${p}` };
    } catch {
      /* next path */
    }
  }
  return { ok: false, notes: "no account page rendered an authenticated view" };
}

async function gotoFirstThatLoads(page, host, paths) {
  for (const p of paths) {
    try {
      const resp = await page.goto(`https://www.${host}${p}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      const status = resp?.status?.() ?? 0;
      if (status && status < 400) {
        // Confirm it actually has a password field (a real auth page), not a 200 soft-404.
        await page.waitForTimeout(800);
        if ((await page.locator('input[type="password"]').count().catch(() => 0)) > 0) return true;
      }
    } catch {
      /* try the next path */
    }
  }
  return false;
}

// Generic LOGIN. Deterministic-first: find the auth form, fill it, submit,
// verify. Falls back to a Stagehand agent when the form isn't reachable by the
// common paths / selectors (multi-step "enter email, then password" flows, a
// login modal behind a "Sign in" button, etc.). Returns {ok, notes}.
//
// `stagehand` may be null to run pure-deterministic (used from the raw-Playwright
// account path); pass it to enable the agent fallback.
export async function genericLogin(page, { email, password, host, loginUrl, stagehand = null, onStep = null } = {}) {
  const step = (s, a) => onStep && onStep({ step: s, action: a });

  // 1) Get to a page that has a password field.
  let onForm = false;
  if (loginUrl) {
    try {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      onForm = (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
    } catch {
      /* fall through to path probing */
    }
  }
  if (!onForm) onForm = await gotoFirstThatLoads(page, host, LOGIN_PATHS);

  // 1b) Agent fallback: click a "Sign in" link/modal opener if we still have no form.
  if (!onForm && stagehand) {
    step("login", "no login form via known paths — asking agent to open the sign-in form");
    await stagehand
      .act('Open the account sign-in / log-in form: click the "Sign in", "Log in", "Account", or "My Account" link or button in the header. Do NOT create a new account.')
      .catch(() => {});
    await page.waitForTimeout(1500);
    onForm = (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  }

  // 2) Fill + submit. Try deterministic first. Dismiss consent BEFORE filling:
  // an overlay covering the form makes locator.fill() report the inputs as
  // unreachable, so the submit posts empty and the site's "this field is
  // required" answer reads back as bad credentials.
  await dismissConsent(page);
  const filledEmail = await tryFill(page, EMAIL_SELECTORS, email);
  // Some flows reveal the password only after the email + a "Continue" click.
  if (filledEmail && (await countRendered(page, 'input[type="password"]')) === 0) {
    await clickSubmit(page);
    await page.waitForTimeout(1500);
  }
  const filledPass = await tryFill(page, PASSWORD_SELECTORS, password);

  if ((!filledEmail || !filledPass) && stagehand) {
    step("login", "deterministic fill incomplete — handing the form to the agent");
    await stagehand
      .act(`Log in to this site. Enter the email "${email}" in the email/username field and the password into the password field, then click the sign-in / log-in button. Do NOT register a new account and do NOT submit any other form.`)
      .catch(() => {});
  } else {
    await clickSubmit(page);
  }

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const verdict = await looksLoggedIn(page);
  step("login", `${verdict.ok ? "ok" : "not-confirmed"}: ${verdict.reason}`);
  return { ok: verdict.ok, notes: verdict.reason };
}

// ---------------------------------------------------------------------------
// Generic SIGNUP (account provisioning). Registration forms vary far more than
// login forms (name, company, phone, confirm-password, checkboxes, captchas),
// so this leans on the Stagehand agent to fill whatever the form asks, using the
// client's real purchasing email + a generated password, then classifies the
// outcome. The win condition is "accepted, awaiting email confirmation" — we
// can't read the client's mailbox, so a human clicks the confirm link once
// (a case is opened by signup.mjs) and the account flips to active.
// ---------------------------------------------------------------------------
function signupInstruction({ email, password, firstName, lastName, company }) {
  return [
    `Create a new customer / buyer account on this website so we can see wholesale pricing.`,
    `Use EXACTLY these details:`,
    `- Email: ${email}`,
    `- Password: ${password} (also enter it in any "confirm password" field)`,
    `- First name: ${firstName}`,
    `- Last name: ${lastName}`,
    `- Company / business name: ${company}`,
    `Steps: if there is a "Register" / "Create account" / "Sign up" link, click it to open the form. Fill every REQUIRED field with the details above; for a required phone use a plausible business number if none is given. Accept terms/privacy checkboxes if required to submit. Then click the Create Account / Register / Sign Up button ONCE.`,
    `HARD RULES: only create THIS account. Do NOT log into an existing account, do NOT submit a newsletter-only form, do NOT enter payment/credit-card details, and do NOT complete a "request a quote" form. If the page demands a phone verification code, an email code, or a captcha you cannot solve, stop — that is an acceptable outcome.`,
  ].join("\n");
}

// Anchor-scan register-URL discovery. Path probing only covers the common
// platform URLs; many sites (PrestaShop and friends) expose the register form
// behind a JS-decorated link or a nonstandard path. Scan the DOM for
// register-ish anchors on the CURRENT page and return candidates, best first.
const REGISTER_LINK_RE = /(regist|create.{0,4}account|sign.?up|new.?customer|open.{0,4}account|join)/i;
const LOGIN_LINK_RE = /(sign.?in|log.?in|account)/i;

async function collectAnchors(page) {
  return await page
    .evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((a) => ({
        href: a.href,
        text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 80),
      }))
    )
    .catch(() => []);
}

function rankRegisterCandidates(anchors, host) {
  const seen = new Set();
  return anchors
    .filter((a) => a.href && a.href.startsWith("http"))
    .filter((a) => {
      try {
        const h = new URL(a.href).hostname.replace(/^www\./, "");
        const bare = host.replace(/^www\./, "");
        return h === bare || h.endsWith("." + bare) || bare.endsWith("." + h);
      } catch {
        return false;
      }
    })
    .map((a) => {
      let score = 0;
      if (REGISTER_LINK_RE.test(a.href)) score += 2;
      if (REGISTER_LINK_RE.test(a.text)) score += 2;
      if (/create|register|new customer/i.test(a.text)) score += 1;
      return { ...a, score };
    })
    .filter((a) => a.score >= 2)
    .sort((a, b) => b.score - a.score)
    .filter((a) => {
      const k = a.href.split("#")[0];
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((a) => a.href);
}

// Discover the real registration URL by reading the site's own links: scan the
// homepage, then the sign-in page (many platforms put "Create account" there —
// the PrestaShop pattern), then follow the best candidates until one renders a
// registration form.
export async function discoverRegisterUrl(page, host, { onStep = null } = {}) {
  const step = (s) => onStep && onStep({ step: "register-discovery", action: s });
  const candidates = [];

  await page.goto(`https://www.${host}/`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const homeAnchors = await collectAnchors(page);
  candidates.push(...rankRegisterCandidates(homeAnchors, host));

  // Follow the sign-in link and scan there too (register links often live on the auth page).
  const loginLink = homeAnchors.find((a) => LOGIN_LINK_RE.test(a.text) && a.href?.startsWith("http"));
  if (loginLink) {
    await page.goto(loginLink.href, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    candidates.push(...rankRegisterCandidates(await collectAnchors(page), host));
    // The auth page itself may BE the combined login+register page.
    if (await onRegistrationForm(page)) {
      step(`auth page doubles as registration: ${page.url()}`);
      return page.url();
    }
  }

  const unique = [...new Set(candidates)];
  step(`candidates: ${unique.slice(0, 5).join(" | ") || "(none)"}`);
  for (const url of unique.slice(0, 5)) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1000);
    if (await onRegistrationForm(page)) {
      step(`registration form at ${page.url()}`);
      return page.url();
    }
  }
  return null;
}

// A registration form as the page's own markup identifies it. Class-based
// matching matters: WooCommerce ships `form.woocommerce-form-register` with no
// id and a plain `/my-account/` action, so id/action-only detection misses every
// WooCommerce storefront (that is what hid chemnovatic's register form from us).
const REGISTER_FORM_SEL = [
  "form.register",
  "form.woocommerce-form-register",
  "form#customer-form",
  'form[id*="register" i]',
  'form[action*="regist" i]',
  'form[action*="create_account" i]',
  'form[action*="save_new_account" i]', // BigCommerce
  'form[action*="createpost" i]', // Magento
  "form.form-create-account", // Magento
  'form[id*="accountcreate" i]', // Magento
].join(", ");

// Cheap deterministic consent/cookie dismissal. A consent overlay leaves the
// form in the DOM but non-interactable, which reads as "no registration form"
// and silently aborts a signup. No LLM here — this runs before every probe.
const CONSENT_TEXTS = ["Accept all", "Accept All", "Allow all", "Accept cookies", "Accept", "I agree", "Got it", "Reject all"];
async function dismissConsent(page) {
  await page.keyboard?.press("Escape").catch(() => {});
  const hit = await clickInPage(page, { texts: CONSENT_TEXTS });
  if (hit) await page.waitForTimeout(600);
  return !!hit;
}

// Scroll a DOM-present registration form into view. Themes that lazy-render or
// park the form far below the fold report it as not-visible until it is scrolled
// to, so probe-then-give-up loses forms that are perfectly fillable.
async function revealRegistrationForm(page) {
  const found = await page
    .evaluate((sel) => {
      const f = document.querySelector(sel);
      if (!f) return false;
      f.scrollIntoView({ block: "center" });
      return true;
    }, REGISTER_FORM_SEL)
    .catch(() => false);
  if (found) await page.waitForTimeout(700);
  return found;
}

// True when the current page shows a registration form (a password field that is
// NOT a plain login — heuristically, a create/register/new-customer context or a
// confirm-password field).
async function onRegistrationForm(page, { waitMs = 8000 } = {}) {
  await dismissConsent(page);
  await revealRegistrationForm(page);
  // Registration fields are often JS-rendered (PrestaShop et al. ship the form
  // shell in HTML and hydrate the inputs) — poll for the password field instead
  // of reading once.
  const deadline = Date.now() + waitMs;
  let passwords = 0;
  for (;;) {
    passwords = await countRendered(page, 'input[type="password"]');
    if (passwords > 0 || Date.now() > deadline) break;
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1000);
  }
  if (passwords === 0) {
    // Fields not hydrated yet, but a registration form SHELL is a strong signal
    // (WooCommerce/PrestaShop register forms, generic register markers).
    const shell = await page
      .evaluate((sel) => !!document.querySelector(`${sel}, input[name="submitCreate"]`), REGISTER_FORM_SEL)
      .catch(() => false);
    return shell;
  }
  if (passwords >= 2) return true; // password + confirm → almost always registration
  const body = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).toLowerCase();
  return /(create (an )?account|register|new customer|sign up|create your account)/i.test(body);
}

// Tick required consent checkboxes (terms/privacy/age) so the form can submit.
// Only checks unchecked boxes; never touches marketing-only opt-ins by preference
// but errs toward checking required ones since forms block submit otherwise.
// Ticked in-page rather than through the locator API: the Stagehand page wrapper
// does not expose Locator.check()/isChecked(), so the previous version threw into
// a .catch() and silently ticked NOTHING — every consent-gated registration form
// failed validation for no visible reason. A real .click() (not a `checked =`
// assignment) keeps framework-controlled checkboxes in sync.
async function acceptRequiredCheckboxes(page, prefix = "") {
  return await page
    .evaluate((p) => {
      const scope = p ? document.querySelector(p) : document;
      if (!scope) return 0;
      let n = 0;
      for (const b of [...scope.querySelectorAll('input[type="checkbox"]')].slice(0, 8)) {
        if (!b.checked) {
          b.click();
          n++;
        }
      }
      return n;
    }, prefix || null)
    .catch(() => 0);
}

async function fillRegistration(page, { email, password, firstName, lastName, company, country = "United States (US)" }) {
  // The form shell may be detected before its inputs hydrate — wait for a
  // visible password field before filling.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await countRendered(page, 'input[type="password"]')) > 0) break;
    await page.waitForTimeout(1000);
  }
  // Scope every fill to the registration form when the page exposes one. On a
  // combined login+register page an unscoped fill lands in the LOGIN form
  // (its `username`/`password` inputs come first) and submits a sign-in for an
  // account that does not exist yet.
  const prefix = await registerFormPrefix(page);
  const scoped = (sels) => (prefix ? sels.map((s) => `${prefix} ${s}`) : sels);

  await tryFill(page, scoped(['input[name*="first" i]', 'input[autocomplete="given-name"]', 'input[id*="first" i]', 'input[placeholder*="first" i]']), firstName);
  await tryFill(page, scoped(['input[name*="last" i]', 'input[autocomplete="family-name"]', 'input[id*="last" i]', 'input[placeholder*="last" i]']), lastName);
  await tryFill(page, scoped(['input[name*="company" i]', 'input[name*="organization" i]', 'input[id*="company" i]', 'input[placeholder*="company" i]']), company);
  const gotEmail = await tryFill(page, scoped(EMAIL_SELECTORS), email);
  const gotPass = await tryFill(page, scoped(PASSWORD_SELECTORS), password);
  await tryFill(page, scoped(['input[name*="confirm" i]', 'input[name*="password_confirmation" i]', 'input[id*="confirm" i]', 'input[placeholder*="confirm" i]']), password);

  await selectCountry(page, prefix ?? "", country);
  await acceptRequiredCheckboxes(page, prefix ?? "");
  return gotEmail && gotPass;
}

// A required country selector silently blocks submit on B2B storefronts: the
// form just does not submit and renders no error. Set through the DOM because
// these are usually select2-enhanced — the real <select> is hidden, so
// Locator.selectOption() cannot reach it — and notify jQuery so the widget and
// any dependent fields (state, VAT) update too.
async function selectCountry(page, prefix, country) {
  return await page
    .evaluate(
      ({ p, want }) => {
        const scope = p ? document.querySelector(p) : document;
        const sel = scope?.querySelector('select[name*="country" i], select[id*="country" i]');
        if (!sel) return null;
        const opts = [...sel.options];
        const match = opts.find((o) => o.text.trim() === want) || opts.find((o) => /united states/i.test(o.text)) || opts.find((o) => o.value === "US");
        if (!match) return null;
        sel.value = match.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        if (window.jQuery) window.jQuery(sel).trigger("change");
        return match.value;
      },
      { p: prefix || null, want: country }
    )
    .catch(() => null);
}

// Which single register-form selector actually matches this page, for use as a
// CSS scope prefix. A Locator would be tidier but does not survive the Stagehand
// page wrapper, so scoping is done in the selector string.
async function registerFormPrefix(page) {
  for (const s of REGISTER_FORM_SEL.split(", ")) {
    if (await page.locator(s).first().count().catch(() => 0)) return s;
  }
  return null;
}

// Browserbase solves reCAPTCHA in the background, so a submit fired too early
// posts an empty g-recaptcha-response and the site rejects the registration as
// a bot. Wait for the token to land before pressing anything.
async function awaitCaptchaToken(page, timeoutMs = 60000) {
  const present = await page
    .evaluate(() => !!document.querySelector('textarea[name="g-recaptcha-response"], iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]'))
    .catch(() => false);
  if (!present) return "none";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tok = await page
      .evaluate(() => [...document.querySelectorAll('textarea[name="g-recaptcha-response"]')].map((t) => t.value).find((v) => v && v.length > 20) ?? "")
      .catch(() => "");
    if (tok) return "solved";
    await page.waitForTimeout(2000);
  }
  return "timeout";
}

// Submit the registration form specifically. Scoped so we never press the
// neighbouring "Log in" button on a combined page.
async function submitRegistration(page) {
  await awaitCaptchaToken(page);
  const prefix = await registerFormPrefix(page);
  const hit = await clickInPage(page, {
    scope: prefix || "password-form",
    selectors: ['button[name="register"]', 'button[type="submit"]', 'input[type="submit"]'],
    texts: ["Create an Account", "Create Account", "Create account", "Register", "Sign up", "Sign Up", "Create"],
  });
  return hit ?? clickSubmit(page);
}

export async function genericSignup(page, { email, password, firstName, lastName, company, host, signupUrl, stagehand = null, onStep = null } = {}) {
  const step = (s, a) => onStep && onStep({ step: s, action: a });

  // 1) Reach a registration form. Explicit URL → known paths → agent opens the
  //    "Create account / Register / New customers" link → homepage fallback.
  let onForm = false;
  if (signupUrl) {
    await page.goto(signupUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    onForm = await onRegistrationForm(page);
  }
  if (!onForm) {
    for (const p of SIGNUP_PATHS) {
      try {
        await page.goto(`https://www.${host}${p}`, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForTimeout(700);
        if (await onRegistrationForm(page)) { onForm = true; break; }
      } catch {
        /* next path */
      }
    }
  }
  // Anchor-scan discovery: read the site's own register links off the homepage
  // and sign-in page (fixes PrestaShop-style sites where the register URL is
  // nonstandard and the link is JS-decorated).
  if (!onForm) {
    const discovered = await discoverRegisterUrl(page, host, { onStep }).catch(() => null);
    if (discovered) onForm = true;
  }
  if (!onForm && stagehand) {
    await page.goto(`https://www.${host}/`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    // ONE targeted act to open the register form (cheap) — not a full agent run.
    await stagehand
      .act('Click the "Create account", "Register", "Sign up", or "New customers" link/button to open the account-registration form. Do NOT sign in to an existing account.')
      .catch(() => {});
    await page.waitForTimeout(1800);
    onForm = await onRegistrationForm(page);
    step("signup", `agent open-form → ${onForm ? "on registration form" : "still not on a form"}`);
  }

  // If we never reached a registration form, do NOT fill anything — the homepage
  // often carries a header sign-IN widget (email+password) and filling it would
  // attempt a login for an account that doesn't exist yet. Bail honestly.
  if (!onForm) {
    step("signup", "no registration form reached — not filling (would hit a sign-in widget)");
    const res = await classifySignupPage(page);
    return { ...res, outcome: res.outcome === "verification_pending" ? res.outcome : "no_form", agent: null, reachedForm: false, filled: false, notes: `no registration form found at known paths for ${host}; add its register URL · ${res.notes}` };
  }

  // 2) Fill the form deterministically (the "auto" agent burns its whole step
  //    budget navigating and rarely completes multi-field forms — proven on
  //    bulkfoods: found the page, never filled it). Deterministic selectors are
  //    reliable on standard registration forms.
  let agentInfo = null;
  const filled = await fillRegistration(page, { email, password, firstName, lastName, company });

  // 2b) If the deterministic fill couldn't find email+password (unusual form),
  //     fall back to the agent to fill THIS page: DOM mode first, then hybrid
  //     (vision, coordinate-based clicks/typing) which handles the canvas-y /
  //     shadow-DOM forms DOM tools can't reach.
  if (!filled && stagehand) {
    for (const mode of ["dom", "hybrid"]) {
      const agent = stagehand.agent(mode === "dom" ? undefined : { mode });
      const nav = await agent
        .execute({ instruction: signupInstruction({ email, password, firstName, lastName, company }), maxSteps: 12 })
        .catch((e) => ({ success: false, message: String(e?.message ?? e).slice(0, 200), actions: [] }));
      agentInfo = { mode, steps: (nav?.actions ?? []).length, success: nav?.success ?? null, message: (nav?.message ?? "").slice(0, 200) };
      step("signup", `${mode}-agent filled in ${agentInfo.steps} step(s): ${agentInfo.message}`);
      await page.waitForTimeout(1500);
      const verdictPeek = await classifySignupPage(page);
      if (verdictPeek.outcome !== "unknown" || nav?.success) break; // something happened — stop escalating
    }
  } else {
    step("signup", `deterministic fill ${filled ? "completed" : "incomplete"}; submitting`);
    await submitRegistration(page);
  }

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const res = await classifySignupPage(page);
  return { ...res, agent: agentInfo, reachedForm: onForm, filled };
}

// Read the post-submit page and decide what happened (shared shape with
// adapters.classifySignup). Win = accepted + awaiting confirmation.
export async function classifySignupPage(page) {
  const url = page.url();
  const raw = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 6000);
  const body = raw.toLowerCase();
  const sample = raw.replace(/\s+/g, " ").trim().slice(0, 220);
  const has = (...res) => res.some((re) => re.test(body));

  if (has(/verify your email/i, /confirmation (email|link)/i, /check your (inbox|email|spam)/i, /confirm your (email|account)/i, /we (just )?sent (you )?an? (email|link)/i, /activation (email|link)/i)) {
    return { outcome: "verification_pending", url, notes: `signup accepted; confirmation email sent · ${sample}` };
  }
  // "email already registered" is an ERROR only when it refers to the SUBMITTED
  // address. Do NOT match "already have an account? sign in", which appears as a
  // sign-in link on essentially every registration page (that false-positived
  // bulkfoods.com on the first run).
  if (has(/email .{0,30}already (been )?(taken|registered|in use|used|associated)/i, /already been (taken|registered)/i, /this email .{0,20}(exists|is registered)/i, /account with this email already/i)) {
    return { outcome: "already_exists", url, notes: `email already registered — needs manual login / password reset · ${sample}` };
  }
  // Only a captcha CHALLENGE or REJECTION blocks us. The bare word "recaptcha"
  // does not: invisible reCAPTCHA v3 prints "This form is protected by reCAPTCHA"
  // as static boilerplate on forms that submit perfectly well, and matching it
  // condemned a working Magento signup as a bot wall.
  if (has(/re?captcha (verification )?(failed|error)/i, /failed .{0,20}captcha/i, /are you a robot/i, /not a human/i, /unusual traffic/i, /verify you are (a )?human/i, /verification code/i, /enter the (6|four|six)?[- ]?digit code/i)) {
    return { outcome: "blocked", url, notes: `captcha / phone-or-email verification wall during signup · ${sample}` };
  }
  // The URL heuristic alone is a trap on combined login/register pages: a
  // rejected submit re-renders at /my-account/ and would read as success. Only
  // trust it when the page isn't showing an error.
  const errored = has(/^error[:!]/i, /\berror:/i, /please try again/i);
  if (has(/thank you for (registering|signing up|creating)/i, /account (has been )?(created|registered)/i, /registration (complete|successful)/i, /welcome to/i) || (!errored && /\/(dashboard|my-?account|onboarding|welcome|account\/success)/.test(url))) {
    return { outcome: "verification_pending", url, notes: `signup appears accepted · ${sample}` };
  }
  return { outcome: "unknown", url, notes: `could not classify signup outcome — inspect the session · ${sample}` };
}

// Zod schema left exported for any caller that wants to have the agent report a
// structured signup verdict (not required by the classifier above).
export const SIGNUP_VERDICT = z.object({
  submitted: z.boolean(),
  outcome: z.enum(["verification_pending", "already_exists", "blocked", "unknown"]).nullable(),
  notes: z.string().nullable(),
});
