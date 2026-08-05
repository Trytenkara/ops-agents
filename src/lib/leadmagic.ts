// LeadMagic enrichment layer. Two-step, domain-first chain against LeadMagic's
// v1 API:
//   1. Role Finder (POST /v1/people/role-finder) — domain + a sourcing job title
//      -> the matching person (name). 2 credits when a person is found, FREE on
//      no match.
//   2. Email Finder (POST /v1/people/email-finder) — that person's name + domain
//      -> a deliverability-validated work email. 1 credit when valid, FREE on
//      null.
// Pay-per-result: a supplier with no reachable POC costs nothing. Credits are a
// single shared pool (~$0.007 each).
//
// Fallback slot: runs AFTER Hunter (and web + Tenkara) found no direct email,
// before ZoomInfo. Soft dependency: every failure path returns null / []. A
// LeadMagic outage, empty balance, or misconfiguration must NEVER block
// enrichment or outreach.

import { recordContactApiCall } from "@/lib/contact-provider-usage";

const BASE = "https://api.leadmagic.io";
const API_KEY = process.env.LEADMAGIC_API_KEY ?? "";
const TIMEOUT_MS = 9_000;

// Sourcing-relevant titles, best first. Role Finder matches partial titles, so
// "procurement" also hits "Procurement Manager". We walk these until we find a
// person, so the most useful POC for a sourcing reply is tried first.
const TITLES = [
  "procurement",
  "purchasing",
  "sourcing",
  "supply chain",
  "sales manager",
  "sales",
  "owner",
  "managing director",
];

export interface LeadMagicContact {
  email: string | null;
  phone: string | null;
  contactName: string | null;
  title: string | null;
  source: "leadmagic";
}

export function isLeadMagicConfigured(): boolean {
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

async function lmPost(path: string, body: unknown, domain: string | null): Promise<any | null> {
  if (!isLeadMagicConfigured()) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "X-API-Key": API_KEY,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const outcome = res.status === 429 ? "quota" : res.status === 401 || res.status === 403 ? "auth" : "error";
      recordContactApiCall({ provider: "leadmagic", outcome, units: 0, domain, detail: `HTTP ${res.status} on ${path}` });
      return null;
    }
    return await res.json();
  } catch (e: any) {
    const timedOut = e?.name === "AbortError";
    recordContactApiCall({ provider: "leadmagic", outcome: "error", units: 0, domain, detail: timedOut ? `timeout after ${TIMEOUT_MS}ms` : String(e?.message ?? e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function nameParts(role: any): { first: string | null; last: string | null; full: string | null } {
  const first = role?.first_name ? String(role.first_name).trim() : null;
  const last = role?.last_name ? String(role.last_name).trim() : null;
  const full = role?.full_name || role?.name
    ? String(role.full_name ?? role.name).trim()
    : [first, last].filter(Boolean).join(" ").trim() || null;
  return { first, last, full: full || null };
}

// Up to `max` POCs for a supplier domain: walk the sourcing titles, resolve a
// person per title via Role Finder, then validate their email via Email Finder.
// Deduped by email. Empty array on any miss (no domain, no key, no roles, no
// deliverable email, or quota exhausted).
export async function enrichContactsViaLeadMagic(
  input: { companyName: string | null; website: string | null },
  max = 5
): Promise<LeadMagicContact[]> {
  if (!isLeadMagicConfigured() || max < 1) return [];
  const domain = domainOf(input.website);
  const companyName = input.companyName?.trim() || null;
  if (!domain && !companyName) return [];

  const out: LeadMagicContact[] = [];
  const seenEmails = new Set<string>();
  const seenNames = new Set<string>();

  for (const title of TITLES) {
    if (out.length >= max) break;

    const role = await lmPost(
      "/v1/people/role-finder",
      { job_title: title, ...(domain ? { company_domain: domain } : {}), ...(companyName ? { company_name: companyName } : {}) },
      domain
    );
    const { first, last, full } = nameParts(role);
    // 2 credits on a role hit, free on no match.
    if (role) recordContactApiCall({ provider: "leadmagic", outcome: full ? "hit" : "miss", units: full ? 2 : 0, domain, detail: `role-finder: ${title}` });
    if (!full) continue;

    const nameKey = full.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const finder = await lmPost(
      "/v1/people/email-finder",
      {
        ...(first ? { first_name: first } : {}),
        ...(last ? { last_name: last } : {}),
        ...(!first && !last ? { full_name: full } : {}),
        ...(domain ? { domain } : {}),
        ...(companyName ? { company_name: companyName } : {}),
      },
      domain
    );
    // 1 credit on a valid email, free otherwise.
    const valid = finder?.status === "valid";
    if (finder) recordContactApiCall({ provider: "leadmagic", outcome: valid ? "hit" : "miss", units: valid ? 1 : 0, domain, detail: "email-finder" });
    if (!valid) continue;

    const email = String(finder?.email ?? "").trim().toLowerCase();
    if (!email.includes("@") || seenEmails.has(email)) continue;
    seenEmails.add(email);

    out.push({
      email,
      phone: null,
      contactName: full,
      title: role?.job_title ?? title,
      source: "leadmagic",
    });
  }

  return out;
}

// Single best POC — the fallback contract. Returns the first title match that
// resolves to a validated email, or null.
export async function enrichContactViaLeadMagic(input: {
  companyName: string | null;
  website: string | null;
}): Promise<LeadMagicContact | null> {
  const [best] = await enrichContactsViaLeadMagic(input, 1);
  return best ?? null;
}

// Primary-fallback variant that ALSO surfaces the POC name when the person is
// found but no deliverable email validates. Same title walk and identical credit
// cost as enrichContactViaLeadMagic (role-finder on each title, email-finder on
// each named person) — it just doesn't throw the name away on an email miss, so
// the guessed-pattern fallback in enrich.ts can synthesize an address on the
// supplier's own domain (a human reviews the draft before send). `contact` is a
// validated email when one lands; `person` is the FIRST role hit seen regardless.
export async function enrichPrimaryViaLeadMagic(input: {
  companyName: string | null;
  website: string | null;
}): Promise<{ contact: LeadMagicContact | null; person: { name: string; title: string | null } | null }> {
  if (!isLeadMagicConfigured()) return { contact: null, person: null };
  const domain = domainOf(input.website);
  const companyName = input.companyName?.trim() || null;
  if (!domain && !companyName) return { contact: null, person: null };

  let person: { name: string; title: string | null } | null = null;
  const seenNames = new Set<string>();

  for (const title of TITLES) {
    const role = await lmPost(
      "/v1/people/role-finder",
      { job_title: title, ...(domain ? { company_domain: domain } : {}), ...(companyName ? { company_name: companyName } : {}) },
      domain
    );
    const { first, last, full } = nameParts(role);
    if (role) recordContactApiCall({ provider: "leadmagic", outcome: full ? "hit" : "miss", units: full ? 2 : 0, domain, detail: `role-finder: ${title}` });
    if (!full) continue;

    if (!person) person = { name: full, title: role?.job_title ?? title };

    const nameKey = full.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const finder = await lmPost(
      "/v1/people/email-finder",
      {
        ...(first ? { first_name: first } : {}),
        ...(last ? { last_name: last } : {}),
        ...(!first && !last ? { full_name: full } : {}),
        ...(domain ? { domain } : {}),
        ...(companyName ? { company_name: companyName } : {}),
      },
      domain
    );
    const valid = finder?.status === "valid";
    if (finder) recordContactApiCall({ provider: "leadmagic", outcome: valid ? "hit" : "miss", units: valid ? 1 : 0, domain, detail: "email-finder" });
    if (!valid) continue;

    const email = String(finder?.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    return {
      contact: { email, phone: null, contactName: full, title: role?.job_title ?? title, source: "leadmagic" },
      person,
    };
  }

  return { contact: null, person };
}
