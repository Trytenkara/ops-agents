// Browserbase session factory with rotating residential proxies + stealth, and
// a ban-aware rotation helper. Each session is a fresh cloud browser; enabling
// proxies routes it through a rotating residential IP so repeated logins to the
// same marketplace don't come from one address that gets banned. On a detected
// block we tear the session down and open a new one (new IP / new geolocation).
import { Browserbase } from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

const API_KEY = process.env.BROWSERBASE_API_KEY;
const PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

// Pool of US cities to vary the exit IP across rotation attempts. undefined =>
// proxies:true (Browserbase picks a rotating US residential proxy).
export const US_GEOS = [
  undefined,
  { city: "NEW_YORK", state: "NY", country: "US" },
  { city: "CHICAGO", state: "IL", country: "US" },
  { city: "LOS_ANGELES", state: "CA", country: "US" },
  { city: "DALLAS", state: "TX", country: "US" },
  { city: "ATLANTA", state: "GA", country: "US" },
];

export class BanError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BanError";
  }
}

export function bbClient() {
  if (!API_KEY) throw new Error("BROWSERBASE_API_KEY not set");
  return new Browserbase({ apiKey: API_KEY });
}

export async function createSession({ geolocation, viewport } = {}) {
  const bb = bbClient();
  const proxies = geolocation ? [{ type: "browserbase", geolocation }] : true;
  return bb.sessions.create({
    projectId: PROJECT_ID,
    proxies,
    browserSettings: {
      solveCaptchas: true,
      fingerprint: { devices: ["desktop"], operatingSystems: ["macos", "windows"] },
      // Asking here rather than with page.setViewportSize() after connecting.
      // Both work today, but a custom viewport is unsupported on Verified
      // sessions, and a caller that screenshots a fixed clip cannot afford to
      // find that out silently.
      ...(viewport ? { viewport } : {}),
    },
  });
}

export async function openSession(opts) {
  const session = await createSession(opts);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { session, browser, context, page, viewUrl: `https://browserbase.com/sessions/${session.id}` };
}

const BLOCK_SIGNALS = [
  /access denied/i,
  /are you a robot/i,
  /captcha/i,
  /unusual traffic/i,
  /verify you are human/i,
  /request blocked/i,
  /rate limit/i,
];

// HTTP-status block = an IP-level ban that will hit EVERY lead → rotate to a
// fresh residential IP and retry the run.
export function looksBlockedStatus(status) {
  return status === 403 || status === 429 || status === 503;
}

// Body-text block signals (captcha / "access denied" / bot-check wording) on an
// otherwise-200 page are almost always specific to THAT listing, not an IP ban.
// The caller should flag just that lead and continue — NOT rotate/abort the run.
export function looksBlockedBody(bodyText) {
  return Boolean(bodyText && BLOCK_SIGNALS.some((re) => re.test(bodyText)));
}

export function looksBlocked(status, bodyText) {
  return looksBlockedStatus(status) || looksBlockedBody(bodyText);
}

// The whole Browserbase session/page died mid-loop (session timeout, proxy drop,
// navigation crash). Continuing on this page would fail for every remaining lead,
// so the caller should rotate to a fresh session and resume (progress is kept via
// the per-run `done` set) rather than either aborting or spinning on a dead page.
export function isSessionDead(err) {
  const m = String(err?.message ?? err ?? "");
  return /Target (page|closed)|context or browser has been closed|browser has been closed|Session .*(closed|expired|disconnect)|websocket|CDP|Connection closed|detached/i.test(m);
}

// Run fn(session, attempt) inside a fresh proxied session. If fn throws a
// BanError, rotate to a new session (next geolocation) and retry, up to
// maxAttempts. Any other error propagates immediately.
export async function withRotatingSession(fn, { maxAttempts = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const geolocation = US_GEOS[attempt % US_GEOS.length];
    const s = await openSession({ geolocation });
    try {
      const out = await fn(s, attempt);
      await s.browser.close().catch(() => {});
      return out;
    } catch (e) {
      lastErr = e;
      await s.browser.close().catch(() => {});
      if (e?.name !== "BanError") throw e;
      // else: banned on this IP — loop to a fresh session/IP
    }
  }
  throw lastErr ?? new Error("exhausted rotating sessions");
}
