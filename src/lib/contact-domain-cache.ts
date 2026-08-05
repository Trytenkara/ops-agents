// Per-domain contact memo (migration 0090).
//
// A supplier's contact details are a property of the DOMAIN, not of the lead, so
// resolving them once and reusing the answer removes the duplicate work — and the
// duplicate paid-provider billing — that comes from the same supplier arriving as
// several leads across materials and orgs.
//
// Two things are cached:
//   a HIT  — reuse the contact directly, no crawl fallthrough, no paid call.
//   a MISS — suppress the PAID providers only, until retry_after elapses.
//
// A miss is never terminal. retry_after follows an exponential curve and the
// domain is re-attempted forever; the free crawl is never suppressed, so a site
// that publishes an email later still gets picked up on the next lead.
//
// Soft dependency in both directions: any failure returns null / no-ops, because
// a cache problem must never block enrichment.

import { createAdminClient } from "@/lib/supabase/admin";

export interface CachedContact {
  domain: string;
  email: string | null;
  phone: string | null;
  contact_url: string | null;
  poc_name: string | null;
  poc_title: string | null;
  source: string | null;
  confidence: string | null;
  miss_count: number;
  retry_after: string | null;
}

// Days before a domain that resolved to nothing is worth paying to look up again.
const MISS_BACKOFF_DAYS = [1, 3, 7, 14, 30];

function backoffFrom(missCount: number): string {
  const days = MISS_BACKOFF_DAYS[Math.min(missCount, MISS_BACKOFF_DAYS.length - 1)];
  return new Date(Date.now() + days * 86400000).toISOString();
}

// Registrable-ish key: strip scheme, www and path. Subdomains are kept on
// purpose, because a storefront subdomain is a different supplier than its
// parent (bozewon.en.alibaba.com is not alibaba.com).
export function contactDomainKey(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const u = new URL(website.startsWith("http") ? website : `https://${website}`);
    const h = u.hostname.replace(/^www\./i, "").toLowerCase();
    return h.includes(".") ? h : null;
  } catch {
    return null;
  }
}

export async function readContactDomainCache(domain: string): Promise<CachedContact | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("contact_domain_cache")
      .select("domain, email, phone, contact_url, poc_name, poc_title, source, confidence, miss_count, retry_after")
      .eq("domain", domain)
      .maybeSingle();
    return (data as CachedContact | null) ?? null;
  } catch {
    return null;
  }
}

// True when this domain resolved to nothing recently enough that paying a
// provider to ask again would just re-buy the same miss.
export function paidLookupSuppressed(cached: CachedContact | null): boolean {
  if (!cached || cached.email) return false;
  return !!cached.retry_after && new Date(cached.retry_after).getTime() > Date.now();
}

export async function writeContactDomainCache(input: {
  domain: string;
  email: string | null;
  phone: string | null;
  contact_url: string | null;
  poc_name: string | null;
  poc_title: string | null;
  source: string | null;
  confidence: string | null;
  priorMissCount: number;
}): Promise<void> {
  const now = new Date().toISOString();
  // A guessed-pattern email is a synthesis of a name and a domain, not a
  // resolution: caching it as a hit would freeze the guess in place and stop the
  // domain ever being re-read for the real address. Cache the NAME (which is the
  // expensive part to find) and leave the domain on the miss curve.
  const isHit = !!input.email && input.confidence !== "guessed";
  const missCount = isHit ? 0 : input.priorMissCount + 1;
  try {
    const admin = createAdminClient();
    await admin.from("contact_domain_cache").upsert(
      {
        domain: input.domain,
        email: isHit ? input.email : null,
        phone: input.phone,
        contact_url: input.contact_url,
        poc_name: input.poc_name,
        poc_title: input.poc_title,
        source: isHit ? input.source : null,
        confidence: isHit ? input.confidence : null,
        miss_count: missCount,
        resolved_at: isHit ? now : null,
        last_attempt_at: now,
        retry_after: isHit ? null : backoffFrom(missCount),
        updated_at: now,
      },
      { onConflict: "domain" }
    );
  } catch {
    /* cache write is best-effort */
  }
}

export async function recordContactCacheHit(domain: string): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.rpc("increment_contact_cache_hit", { p_domain: domain });
  } catch {
    /* counter only */
  }
}
