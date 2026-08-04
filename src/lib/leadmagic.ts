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

async function lmPost(path: string, body: unknown): Promise<any | null> {
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
    if (!res.ok) return null;
    return await res.json();
  } catch {
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

    const role = await lmPost("/v1/people/role-finder", {
      job_title: title,
      ...(domain ? { company_domain: domain } : {}),
      ...(companyName ? { company_name: companyName } : {}),
    });
    const { first, last, full } = nameParts(role);
    if (!full) continue;

    const nameKey = full.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const finder = await lmPost("/v1/people/email-finder", {
      ...(first ? { first_name: first } : {}),
      ...(last ? { last_name: last } : {}),
      ...(!first && !last ? { full_name: full } : {}),
      ...(domain ? { domain } : {}),
      ...(companyName ? { company_name: companyName } : {}),
    });
    if (finder?.status !== "valid") continue;

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
