// Whether a failure earns another attempt, or is genuinely over.
//
// Standing rule: never give up on a retryable failure. Only a STRUCTURAL
// verdict is terminal. A structural verdict is one about the thing itself
// ("this URL is a 404", "this site is not a marketplace"). Everything else,
// a timeout, a 500, a rate limit, a dropped browser session, a parse failure
// on a page that was probably a captcha, is about the ATTEMPT, and the attempt
// can be made again.
//
// Nine separate hand-rolled tests grew up across the fleet, each with its own
// idea of what counts. The consequences differed too: one source treats a 5xx
// as "searched, never re-query", another leaves its cursor unadvanced and tries
// again. That divergence is invisible until a supplier is missing for a week.
//
// The default here is RETRY. An unrecognised error is an unknown error, and an
// unknown error is not evidence that the work is impossible. Terminal has to be
// argued for, not fallen into.

export type Verdict = "retry" | "terminal";

export interface RetryVerdict {
  verdict: Verdict;
  /** Short machine label for logs and stored reasons. */
  reason: string;
  /** True when the remote asked us to slow down, so callers can back off harder. */
  rateLimited: boolean;
  /** Suggested wait before the next attempt, in ms. */
  backoffMs: number;
}

const RETRY = (reason: string, backoffMs: number, rateLimited = false): RetryVerdict => ({
  verdict: "retry",
  reason,
  rateLimited,
  backoffMs,
});
const TERMINAL = (reason: string): RetryVerdict => ({
  verdict: "terminal",
  reason,
  rateLimited: false,
  backoffMs: 0,
});

/** Exponential with jitter, capped, so a hot loop cannot hammer a struggling host. */
export function backoffFor(attempt: number, baseMs = 3000, capMs = 5 * 60_000): number {
  const raw = baseMs * 2 ** Math.max(0, attempt);
  return Math.min(capMs, raw) + Math.floor(Math.random() * 2000);
}

function messageOf(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  const any = err as any;
  return String(any.message ?? any.error_description ?? any.error ?? any.reason ?? err);
}

function statusOf(err: unknown): number | null {
  const any = err as any;
  const raw = any?.status ?? any?.statusCode ?? any?.response?.status ?? null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Classify a thrown error or a failed HTTP response.
 *
 * Pass `scope: "page"` when the failure came from fetching a page rather than
 * calling an API, so a refusal is read as a block to route around rather than
 * as a verdict about our credentials.
 *
 * Pass `attempt` (0-based) so the caller gets a backoff that widens, and
 * `maxAttempts` so an otherwise-retryable failure becomes terminal once the
 * budget is spent rather than looping forever inside one run. Exhausting the
 * budget is a verdict about THIS RUN; whether the work is requeued for a later
 * run is the caller's own scheduling decision and should almost always be yes.
 */
export function classifyFailure(
  err: unknown,
  opts: { attempt?: number; maxAttempts?: number; scope?: "api" | "page" } = {}
): RetryVerdict {
  const attempt = opts.attempt ?? 0;
  const msg = messageOf(err);
  const status = statusOf(err);
  const wait = backoffFor(attempt);

  const spent = opts.maxAttempts != null && attempt + 1 >= opts.maxAttempts;
  const budget = (v: RetryVerdict): RetryVerdict =>
    spent && v.verdict === "retry" ? TERMINAL(`${v.reason}_attempts_exhausted`) : v;

  // Explicit signals from our own error classes take precedence over guesswork.
  const name = (err as any)?.name ?? "";
  if (name === "BanError" || (err as any)?.ban) return budget(RETRY("proxy_banned", wait));
  if (/UnavailableError$/.test(name)) return budget(RETRY("upstream_unavailable", wait));

  // Rate limiting. Honour Retry-After when the caller attached one.
  const retryAfter = Number((err as any)?.retryAfterMs ?? (err as any)?.retry_after_ms ?? NaN);
  if (status === 429 || /\b429\b|rate.?limit|too many requests|slow down/i.test(msg)) {
    return budget(RETRY("rate_limited", Number.isFinite(retryAfter) ? retryAfter : wait, true));
  }

  // Structural: the remote understood us and says this specific thing is wrong.
  // 404 is deliberately NOT here. A dead product URL is repairable by search,
  // and treating it as final is how a live listing gets written off.
  // 401/403 from an API is a verdict about our credentials and will not change
  // however often we ask. From a fetched PAGE it is the site refusing this
  // visitor — a bot wall, or a proxy IP that has been banned — and a different
  // IP or a later run clears it. Same status, opposite meaning, so the caller
  // says which question it is asking.
  if (status === 401 || status === 403) {
    return opts.scope === "page" ? budget(RETRY("blocked", wait)) : TERMINAL("not_authorised");
  }
  if (status === 400 || status === 422) return TERMINAL("rejected_by_remote");
  if (status === 402) return TERMINAL("out_of_credit");

  // Transport and infrastructure. All of these are about the attempt.
  if (status != null && status >= 500) return budget(RETRY("upstream_5xx", wait));
  if (
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|fetch failed/i.test(msg)
  ) {
    return budget(RETRY("network", wait));
  }
  if (/timeout|timed out|abort/i.test(msg)) return budget(RETRY("timeout", wait));
  if (
    /target (page|closed)|browser has been closed|session .*(closed|expired|disconnect)|websocket|CDP|connection closed/i.test(
      msg
    )
  ) {
    return budget(RETRY("session_lost", wait));
  }

  // Unrecognised. Retry, and say so plainly in the reason so it shows up in logs
  // as an unclassified failure worth reading rather than as a known category.
  return budget(RETRY("unclassified", wait));
}

/** Convenience for `if (!res.ok)` branches, where there is no Error object yet. */
export function classifyResponse(
  res: { status: number; statusText?: string },
  body: string | null,
  opts: { attempt?: number; maxAttempts?: number } = {}
): RetryVerdict {
  const err: any = new Error(
    `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${body ? `: ${body.slice(0, 200)}` : ""}`
  );
  err.status = res.status;
  return classifyFailure(err, opts);
}

export function isRetryable(err: unknown, opts?: { attempt?: number; maxAttempts?: number }): boolean {
  return classifyFailure(err, opts).verdict === "retry";
}
