// Browserbase session factory with rotating residential proxies + stealth, and
// a ban-aware rotation helper. Ported from the container-side
// `browserbase-price-pull` skill.
//
// The browser runs in Browserbase's cloud, NOT here: `connectOverCDP` opens a
// websocket to a remote Chromium. playwright-core ships no browser binaries and
// never launches one, which is why this works on serverless.
//
// Each session is a fresh cloud browser; enabling proxies routes it through a
// rotating US residential IP so repeated reads of the same marketplace don't all
// come from one address that gets banned. On a detected block we tear the
// session down and open a new one with a different geolocation.

import { Browserbase } from "@browserbasehq/sdk";
import { chromium, type Browser, type Page } from "playwright-core";

// Pool of US cities to vary the exit IP across rotation attempts. undefined =>
// proxies:true, letting Browserbase pick a rotating US residential proxy.
export const US_GEOS: Array<{ city: string; state: string; country: string } | undefined> = [
  undefined,
  { city: "NEW_YORK", state: "NY", country: "US" },
  { city: "CHICAGO", state: "IL", country: "US" },
  { city: "LOS_ANGELES", state: "CA", country: "US" },
  { city: "DALLAS", state: "TX", country: "US" },
  { city: "ATLANTA", state: "GA", country: "US" },
];

export class BanError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BanError";
  }
}

export function browserbaseConfigured(): boolean {
  return Boolean(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID);
}

function bbClient(): Browserbase {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY not set");
  return new Browserbase({ apiKey });
}

export async function createSession(opts: { geolocation?: (typeof US_GEOS)[number] } = {}) {
  const bb = bbClient();
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!projectId) throw new Error("BROWSERBASE_PROJECT_ID not set");
  // Note: `verified` / `advancedStealth` are Enterprise-only and hard-fail with
  // a 403 on this plan. Do not add them. Captcha solving is on by default.
  const proxies: any = opts.geolocation ? [{ type: "browserbase", geolocation: opts.geolocation }] : true;
  return bb.sessions.create({
    projectId,
    proxies,
    browserSettings: {
      solveCaptchas: true,
      fingerprint: { devices: ["desktop"], operatingSystems: ["macos", "windows"] },
    },
  } as any);
}

export interface OpenSession {
  sessionId: string;
  browser: Browser;
  page: Page;
  viewUrl: string;
}

export async function openSession(opts: { geolocation?: (typeof US_GEOS)[number] } = {}): Promise<OpenSession> {
  const session: any = await createSession(opts);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { sessionId: session.id, browser, page, viewUrl: `https://browserbase.com/sessions/${session.id}` };
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

// An HTTP-status block is an IP-level ban that will hit EVERY lead, so the
// caller should rotate to a fresh residential IP and retry the run.
export function looksBlockedStatus(status: number | null | undefined): boolean {
  return status === 403 || status === 429 || status === 503;
}

// Block wording in the body of an otherwise-200 page is almost always specific
// to THAT listing, not an IP ban. Flag just that lead and continue; do not
// rotate or abort the run.
export function looksBlockedBody(bodyText: string | null | undefined): boolean {
  return Boolean(bodyText && BLOCK_SIGNALS.some((re) => re.test(bodyText)));
}

// The whole session/page died mid-loop (session timeout, proxy drop, navigation
// crash). Every remaining lead on this page would fail, so the caller should
// rotate to a fresh session and resume rather than abort or spin on a dead page.
export function isSessionDead(err: unknown): boolean {
  const m = String((err as any)?.message ?? err ?? "");
  return /Target (page|closed)|context or browser has been closed|browser has been closed|Session .*(closed|expired|disconnect)|websocket|CDP|Connection closed|detached/i.test(
    m,
  );
}

/**
 * Run fn inside a fresh proxied session. A BanError rotates to a new session on
 * the next geolocation and retries; any other error propagates immediately.
 */
export async function withRotatingSession<T>(
  fn: (s: OpenSession, attempt: number) => Promise<T>,
  opts: { maxAttempts?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const s = await openSession({ geolocation: US_GEOS[attempt % US_GEOS.length] });
    try {
      const out = await fn(s, attempt);
      await s.browser.close().catch(() => {});
      return out;
    } catch (e) {
      lastErr = e;
      await s.browser.close().catch(() => {});
      if ((e as any)?.name !== "BanError") throw e;
      // Banned on this IP: loop to a fresh session on a different geolocation.
    }
  }
  throw lastErr ?? new Error("exhausted rotating sessions");
}
