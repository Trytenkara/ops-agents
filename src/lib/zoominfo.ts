// ZoomInfo enrichment layer (#9). OAuth2 client-credentials against ZoomInfo's
// GTM Data API: exchange client_id/client_secret for a bearer token (cached
// module-wide until shortly before expiry), then Search Contacts (free) to find
// a supplier's best POC and Enrich Contact (one credit) to return their email +
// phone. Used as a FALLBACK when web-scraping + Tenkara found no direct email.
//
// Soft dependency: every failure path returns null. ZoomInfo being down, out of
// credits, or misconfigured must NEVER block enrichment or outreach.

const BASE = (process.env.ZOOMINFO_API_BASE ?? "https://api.zoominfo.com/gtm").replace(/\/+$/, "");
const CLIENT_ID = process.env.ZOOMINFO_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.ZOOMINFO_CLIENT_SECRET ?? "";

const JSONAPI = "application/vnd.api+json";
const TIMEOUT_MS = 9_000;

// Fields we ask Enrich to return. Kept minimal — each is billed the same, but a
// tight list keeps the response small and intent clear.
const OUTPUT_FIELDS = ["firstName", "lastName", "jobTitle", "email", "phone", "mobilePhone", "companyName"];

export interface ZoomInfoContact {
  email: string | null;
  phone: string | null;
  contactName: string | null;
  title: string | null;
  source: "zoominfo";
}

export function isZoomInfoConfigured(): boolean {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// Module-level token cache. expiresAt is epoch ms; refresh ~60s early.
let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inFlight: Promise<string | null> | null = null;

async function fetchToken(): Promise<string | null> {
  if (!isZoomInfoConfigured()) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/oauth/v1/token`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const token = json?.access_token ?? null;
    const ttl = Number(json?.expires_in ?? 3600);
    if (!token) return null;
    cachedToken = token;
    tokenExpiresAt = Date.now() + Math.max(0, ttl - 60) * 1000;
    return token;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function getToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (inFlight) return inFlight;
  inFlight = fetchToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function ziFetch(path: string, token: string, body: unknown): Promise<any | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      signal: ctl.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": JSONAPI, accept: JSONAPI },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Normalize a company name for loose comparison: lowercase, drop legal suffixes
// and punctuation. Used to confirm ZoomInfo matched the SAME company we searched
// before spending a credit to enrich — guards against same-name-different-company.
const LEGAL_SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|gmbh|srl|sa|sas|bv|pvt|pte|plc|group|holdings)\b/g;
function normCompany(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[.,&()/-]/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Do two company names plausibly refer to the same company? True when the
// normalized token sets have meaningful overlap (one contains the other, or they
// share their leading significant token).
function companyMatches(a: string, b: string): boolean {
  const na = normCompany(a);
  const nb = normCompany(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = na.split(" ").filter((w) => w.length > 2);
  const tb = new Set(nb.split(" ").filter((w) => w.length > 2));
  const shared = ta.filter((w) => tb.has(w));
  return shared.length >= Math.min(2, Math.min(ta.length, tb.size));
}

// Look up the best POC for a supplier: Search Contacts by company name (free,
// email-required, ranked by accuracy), confirm the match is the same company,
// then Enrich the top candidate (one credit) for email + phone. Returns null on
// any miss so the caller keeps whatever channel it already had.
export async function enrichContactViaZoomInfo(input: {
  companyName: string | null;
  website: string | null;
}): Promise<ZoomInfoContact | null> {
  if (!isZoomInfoConfigured()) return null;
  const company = (input.companyName ?? "").trim();
  if (!company) return null;

  const token = await getToken();
  if (!token) return null;

  // Step 1 — Search (free). Only contacts that have an email, best accuracy first.
  const search = await ziFetch(
    "/data/v1/contacts/search?page%5Bnumber%5D=1&page%5Bsize%5D=5&sort=-contactAccuracyScore",
    token,
    { data: { type: "ContactSearch", attributes: { companyName: company, requiredFields: "email" } } }
  );
  const candidates: any[] = Array.isArray(search?.data) ? search.data : [];
  if (!candidates.length) return null;

  // Pick the highest-accuracy candidate whose company actually matches ours.
  const match = candidates.find((c) => companyMatches(company, c?.attributes?.company?.name));
  const personId = match?.id ? String(match.id) : null;
  if (!personId) return null;

  // Step 2 — Enrich (one credit; not charged on NO_MATCH).
  const enrich = await ziFetch("/data/v1/contacts/enrich", token, {
    data: { type: "ContactEnrich", attributes: { matchPersonInput: [{ personId }], outputFields: OUTPUT_FIELDS } },
  });
  const rec = Array.isArray(enrich?.data) ? enrich.data[0] : null;
  const attrs = rec?.attributes;
  if (!attrs) return null;
  if (rec?.meta?.matchStatus && rec.meta.matchStatus !== "FULL_MATCH" && rec.meta.matchStatus !== "PARTIAL_MATCH") {
    return null;
  }

  const email = typeof attrs.email === "string" && attrs.email.includes("@") ? attrs.email.toLowerCase() : null;
  const phone = attrs.phone || attrs.mobilePhone || null;
  const name = [attrs.firstName, attrs.lastName].filter(Boolean).join(" ").trim() || null;
  if (!email && !phone) return null;

  return { email, phone: phone || null, contactName: name, title: attrs.jobTitle ?? null, source: "zoominfo" };
}
