// Hunter.io enrichment layer. Domain Search against Hunter's v2 API: give it a
// supplier's domain and it returns the public POC emails it knows for that
// domain, each with a name, job title, department, confidence score, and
// (sometimes) a phone. One Domain Search spends one search credit.
//
// Primary paid contact fallback: runs AFTER web-scraping + Tenkara found no
// direct email, but BEFORE ZoomInfo and GetProspect. Domain-first, which fits
// our flow (we almost always have the supplier's website by this point).
//
// Soft dependency: every failure path returns null / []. Hunter being down, out
// of credits, or misconfigured must NEVER block enrichment or outreach.

const BASE = "https://api.hunter.io";
const API_KEY = process.env.HUNTER_API_KEY ?? "";
const TIMEOUT_MS = 9_000;

// Below this Hunter confidence we don't trust the address enough to cold-email
// it. Hunter scores 0-100; personal addresses it's sure about sit 80-95.
const MIN_CONFIDENCE = 50;

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

async function domainSearch(domain: string): Promise<any[] | null> {
  if (!isHunterConfigured()) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const query = new URLSearchParams({ domain, limit: "10", api_key: API_KEY });
    const res = await fetch(`${BASE}/v2/domain-search?${query.toString()}`, {
      method: "GET",
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    return Array.isArray(json?.data?.emails) ? json.data.emails : [];
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
  if (!isHunterConfigured() || max < 1) return [];
  const domain = domainOf(input.website);
  if (!domain) return [];

  const emails = await domainSearch(domain);
  if (!emails || !emails.length) return [];

  const ranked = emails
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
