// Hunter.io enrichment layer. Domain Search against Hunter's v2 API: give it a
// supplier's domain and it returns the public POC emails it knows for that
// domain, each with a name, job title, department, confidence score, and
// (sometimes) a phone. On an All-in-one plan this bills 1 credit per email
// revealed (a search that reveals nothing is free), so MAX_EMAILS_PER_DOMAIN
// below is the real cost control.
//
// Primary paid contact fallback: runs AFTER web-scraping + Tenkara found no
// direct email, but BEFORE ZoomInfo and GetProspect. Domain-first, which fits
// our flow (we almost always have the supplier's website by this point).
//
// Soft dependency: every failure path returns null / []. Hunter being down, out
// of credits, or misconfigured must NEVER block enrichment or outreach. But a
// soft failure is NOT silent: every call is journaled to contact-provider-usage
// so an exhausted quota is distinguishable from a genuine miss.

import { recordContactApiCall } from "@/lib/contact-provider-usage";

const BASE = "https://api.hunter.io";
const API_KEY = process.env.HUNTER_API_KEY ?? "";
const TIMEOUT_MS = 9_000;

// Below this Hunter confidence we don't trust the address enough to cold-email
// it. Hunter scores 0-100; personal addresses it's sure about sit 80-95.
const MIN_CONFIDENCE = 50;

// THE COST KNOB. On Hunter's All-in-one plans Domain Search bills 1 credit per
// email REVEALED, not per search, so the API `limit` is what we actually pay.
// We reveal this many per domain and rank locally: enough candidates for the
// procurement-over-sales ranking below to mean something, few enough that a
// month of lookups fits a Starter allowance. Repeat searches on the same domain
// inside a billing period are free, so the CC pass costs nothing extra.
const MAX_EMAILS_PER_DOMAIN = Math.max(1, Number(process.env.HUNTER_MAX_EMAILS_PER_DOMAIN ?? 3));

type SearchResult =
  | { ok: true; emails: any[] }
  | { ok: false; reason: "quota" | "auth" | "error" };

// Latched for the life of the process once Hunter says the allowance is gone.
// Without it every remaining lead in the run pays a full HTTP round-trip to be
// told the same thing. Cleared on cold start, which is well inside the monthly
// reset window.
let quotaExhausted = false;

export function isHunterQuotaExhausted(): boolean {
  return quotaExhausted;
}

export interface HunterContact {
  email: string | null;
  phone: string | null;
  contactName: string | null;
  title: string | null;
  source: "hunter";
}

export function isHunterConfigured(): boolean {
  return !!API_KEY;
}

function domainOf(website: string | null): string | null {
  if (!website) return null;
  try {
    return new URL(website.startsWith("http") ? website : `https://${website}`).hostname
      .replace(/^www\./i, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

// Rank a Hunter email the way we'd triage an inbox for a sourcing reply:
// procurement/purchasing first, then sales/commercial, then leadership, then a
// generic role inbox. A personal address always outranks a generic one at the
// same tier.
function candidateScore(email: any): number {
  const text = `${email?.position ?? ""} ${email?.department ?? ""}`.toLowerCase();
  let base: number;
  if (/procurement|purchas|sourcing|supply chain/.test(text)) base = 5;
  else if (/sales|business development|commercial|account/.test(text)) base = 4;
  else if (/operations|general manager|managing director/.test(text)) base = 3;
  else if (/owner|founder|president|chief executive|ceo|director/.test(text)) base = 2;
  else base = 1;
  const personal = email?.type === "personal" ? 0.5 : 0;
  return base + personal;
}

// Hunter returns 429 with id "too_many_requests" for BOTH "you are going too
// fast" and "your allowance is gone" — the id does not disambiguate, only the
// details string does. The exhausted-allowance body reads "You've reached the
// limit for the number of searches per billing period included in your plan."
//
// So: assume an exhausted allowance unless the body looks like a short-term
// rate limit. Agent 06 does 25 leads a run, nowhere near Hunter's rate ceiling,
// which makes allowance exhaustion overwhelmingly the likelier 429. Guessing
// wrong is cheap either way — the lead just falls through to the next provider,
// and the latch clears on the next cold start.
const RATE_LIMIT_HINT = /per second|per minute|rate limit|too fast|slow down/i;

function isQuotaError(status: number, body: string): boolean {
  return status === 429 && !RATE_LIMIT_HINT.test(body);
}

async function domainSearch(domain: string): Promise<SearchResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const query = new URLSearchParams({
      domain,
      limit: String(MAX_EMAILS_PER_DOMAIN),
      api_key: API_KEY,
    });
    const res = await fetch(`${BASE}/v2/domain-search?${query.toString()}`, {
      method: "GET",
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (isQuotaError(res.status, body)) {
        quotaExhausted = true;
        recordContactApiCall({ provider: "hunter", outcome: "quota", units: 0, domain, detail: `HTTP 429 — allowance exhausted; falling through to ZoomInfo` });
        return { ok: false, reason: "quota" };
      }
      const reason = res.status === 401 || res.status === 403 ? "auth" : "error";
      recordContactApiCall({ provider: "hunter", outcome: reason, units: 0, domain, detail: `HTTP ${res.status}` });
      return { ok: false, reason };
    }
    const json: any = await res.json();
    const emails = Array.isArray(json?.data?.emails) ? json.data.emails : [];
    // A miss costs nothing: Hunter charges only for emails actually revealed.
    recordContactApiCall({
      provider: "hunter",
      outcome: emails.length ? "hit" : "miss",
      units: emails.length,
      domain,
    });
    return { ok: true, emails };
  } catch (e: any) {
    const timedOut = e?.name === "AbortError";
    recordContactApiCall({ provider: "hunter", outcome: "error", units: 0, domain, detail: timedOut ? `timeout after ${TIMEOUT_MS}ms` : String(e?.message ?? e) });
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

// Exact remaining allowance, straight from Hunter. Free — the account endpoint
// does not consume a credit. Used by System health so an exhausted plan is
// visible before it silently reroutes spend to ZoomInfo.
export interface HunterAccount {
  planName: string;
  used: number;
  available: number;
  remaining: number;
  resetDate: string | null;
}

export async function fetchHunterAccount(): Promise<HunterAccount | null> {
  if (!isHunterConfigured()) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/v2/account?api_key=${encodeURIComponent(API_KEY)}`, {
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const d: any = (await res.json())?.data;
    const credits = d?.requests?.credits ?? {};
    const used = Number(credits.used ?? 0);
    const available = Number(credits.available ?? 0);
    return {
      planName: String(d?.plan_name ?? "unknown"),
      used,
      available,
      remaining: Number(credits.remaining ?? Math.max(0, available - used)),
      resetDate: d?.reset_date ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toContact(email: any): HunterContact | null {
  const value = String(email?.value ?? "").trim().toLowerCase();
  if (!value.includes("@")) return null;
  const name = [email?.first_name, email?.last_name].filter(Boolean).join(" ").trim() || null;
  return {
    email: value,
    phone: email?.phone_number ? String(email.phone_number) : null,
    contactName: name,
    title: email?.position ?? null,
    source: "hunter",
  };
}

// Up to `max` POCs for a supplier domain, best-ranked first, deduped by email.
// Empty array on any miss (no domain, no key, provider miss, quota exhausted).
export async function enrichContactsViaHunter(
  input: { companyName: string | null; website: string | null },
  max = 5
): Promise<HunterContact[]> {
  if (!isHunterConfigured() || quotaExhausted || max < 1) return [];
  const domain = domainOf(input.website);
  if (!domain) return [];

  const result = await domainSearch(domain);
  if (!result.ok || !result.emails.length) return [];

  const ranked = result.emails
    .filter((e) => Number(e?.confidence ?? 0) >= MIN_CONFIDENCE)
    .sort((a, b) => candidateScore(b) - candidateScore(a) || Number(b?.confidence ?? 0) - Number(a?.confidence ?? 0));

  const out: HunterContact[] = [];
  const seen = new Set<string>();
  for (const e of ranked) {
    const c = toContact(e);
    if (!c || !c.email) continue;
    if (seen.has(c.email)) continue;
    seen.add(c.email);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

// Single best POC — the primary fallback contract. Delegates to the plural
// lookup and returns the top match (or null).
export async function enrichContactViaHunter(input: {
  companyName: string | null;
  website: string | null;
}): Promise<HunterContact | null> {
  const [best] = await enrichContactsViaHunter(input, 1);
  return best ?? null;
}
