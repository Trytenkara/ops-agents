// A silently truncated read is the most expensive bug shape in this codebase.
//
// PostgREST answers at most 1000 rows and reports NO error when it drops the
// rest. A read that feeds a dedup guard then re-creates everything past the cap
// on every run (migration 0075); a read that feeds a worklist quietly stops
// serving the tail forever. Both look like healthy runs.
//
// selectAllPaged() has existed for a while and about ten of a hundred and sixty
// files use it. That ratio is the point: a rule you have to remember at each
// call site is not enforced. So instead of asking every caller to page, this
// wraps the HTTP layer the whole client already goes through and refuses a
// response that is exactly at the cap and did not ask to be.
//
// The test is positive, not a blocklist: a read is fine if it BOUNDED itself
// (an explicit limit, an explicit range, an aggregate, a single-row fetch). Only
// an unbounded read that came back exactly full is ambiguous, and an ambiguous
// read is treated as truncated, because the alternative is trusting a number
// that happens to be 1000.

const PAGE_CAP = 1000;

function isBounded(url: string, init?: RequestInit): boolean {
  // .limit(n) / .range(a,b) both surface as query params or a Range header.
  if (/[?&]limit=/.test(url)) return true;
  if (/[?&]select=[^&]*\bcount\b/.test(url)) return true;
  const headers = new Headers(init?.headers ?? {});
  if (headers.has("range")) return true;
  // .single() / .maybeSingle() ask for an object, not an array.
  const accept = headers.get("accept") ?? "";
  if (accept.includes("vnd.pgrst.object")) return true;
  return false;
}

function tableOf(url: string): string {
  const m = url.match(/\/rest\/v1\/([^?/]+)/);
  return m ? decodeURIComponent(m[1]) : url;
}

/**
 * Wraps fetch so a full-cap unbounded PostgREST read throws instead of
 * returning a quietly short answer. Pass to createClient({ global: { fetch } }).
 */
export function truncationGuardedFetch(
  baseFetch: typeof fetch = fetch
): typeof fetch {
  return async function guardedFetch(input: any, init?: any): Promise<Response> {
    const res = await baseFetch(input, init);

    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    const method = (init?.method ?? (typeof input === "object" ? input?.method : null) ?? "GET").toUpperCase();
    if (method !== "GET" || !res.ok || !url.includes("/rest/v1/")) return res;
    if (isBounded(url, init)) return res;
    if (!(res.headers.get("content-type") ?? "").includes("json")) return res;

    // Read through a clone so the caller still gets an unconsumed body.
    let rows: unknown;
    try {
      rows = await res.clone().json();
    } catch {
      return res;
    }
    if (!Array.isArray(rows) || rows.length < PAGE_CAP) return res;

    throw new Error(
      `Truncated read of "${tableOf(url)}": PostgREST returned exactly ${PAGE_CAP} rows ` +
        `for a query with no limit or range, so an unknown number of rows were dropped ` +
        `without an error. Page the read with selectAllPaged() from @/lib/supabase-paging ` +
        `(and give it a stable .order()), or state the bound explicitly with .limit() if ` +
        `a partial answer is genuinely what you want.`
    );
  } as typeof fetch;
}
