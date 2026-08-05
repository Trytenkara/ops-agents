import { recordContactApiCall, isContactProviderTripped } from "@/lib/contact-provider-usage";

const BASE = "https://api.getprospect.com";
const API_KEY = (globalThis as any).process?.env?.GETPROSPECT_API_KEY ?? "";
const TIMEOUT_MS = 9_000;

export interface GetProspectContact {
  email: string;
  contactName: string;
  title: string | null;
  source: "getprospect";
}

export function isGetProspectConfigured(): boolean {
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

async function gpRequest(path: string, options: RequestInit, domain: string | null): Promise<any | null> {
  const allowed =
    (path.startsWith("/public/v1/insights/contacts?") && options.method === "POST") ||
    (path.startsWith("/v2/email-finder?") && options.method === "GET");
  if (!allowed || !isGetProspectConfigured()) return null;
  // Monthly quota already hit this run — the insights endpoint just 402s for free.
  if (isContactProviderTripped("getprospect")) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, {
      ...options,
      signal: ctl.signal,
      headers: {
        accept: "application/json",
        apiKey: API_KEY,
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      // The account has a hard monthly quota with no overage path, so a 429 here
      // means dead until the reset, not "retry in a second".
      const outcome = response.status === 429 || response.status === 402 ? "quota" : response.status === 401 || response.status === 403 ? "auth" : "error";
      recordContactApiCall({ provider: "getprospect", outcome, units: 0, domain, detail: `HTTP ${response.status} on ${path.split("?")[0]}` });
      return null;
    }
    return await response.json();
  } catch (e: any) {
    const timedOut = e?.name === "AbortError";
    recordContactApiCall({ provider: "getprospect", outcome: "error", units: 0, domain, detail: timedOut ? `timeout after ${TIMEOUT_MS}ms` : String(e?.message ?? e) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function candidateScore(candidate: any): number {
  const title = String(candidate?.companies?.[0]?.position ?? candidate?.summary ?? "").toLowerCase();
  if (/procurement|purchas|sourcing|supply chain/.test(title)) return 5;
  if (/sales|business development|commercial|account manager/.test(title)) return 4;
  if (/operations|general manager|managing director/.test(title)) return 3;
  if (/owner|founder|president|chief executive|ceo/.test(title)) return 2;
  return 1;
}

export async function enrichContactViaGetProspect(input: {
  companyName: string | null;
  website: string | null;
}): Promise<GetProspectContact | null> {
  if (!isGetProspectConfigured()) return null;

  const companyName = input.companyName?.trim() || null;
  const domain = domainOf(input.website);
  if (!companyName && !domain) return null;

  const searchBody = domain
    ? { domain: { included: [domain], excluded: [] }, email: "all_contacts" }
    : { companyName: { included: [companyName], excluded: [] }, email: "all_contacts" };
  const search = await gpRequest(
    "/public/v1/insights/contacts?pageSize=10&pageNumber=1",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(searchBody) },
    domain
  );
  const candidates: any[] = Array.isArray(search?.data) ? search.data : [];
  if (!candidates.length) {
    if (search) recordContactApiCall({ provider: "getprospect", outcome: "miss", units: 0, domain, detail: "no search candidates" });
    return null;
  }

  const candidate = [...candidates]
    .filter((row) => row?.firstName && row?.lastName)
    .sort((a, b) => candidateScore(b) - candidateScore(a))[0];
  if (!candidate) {
    recordContactApiCall({ provider: "getprospect", outcome: "miss", units: 0, domain, detail: "no named candidate" });
    return null;
  }

  const contactName = `${candidate.firstName} ${candidate.lastName}`.trim();
  const finderDomain = domain || candidate?.companies?.[0]?.company?.domain || null;
  if (!finderDomain) return null;

  const query = new URLSearchParams({
    domain: finderDomain,
    full_name: contactName,
    api_key: API_KEY,
  });
  const found = await gpRequest(`/v2/email-finder?${query.toString()}`, { method: "GET" }, domain);
  const email = String(found?.email ?? found?.data?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) {
    if (found) recordContactApiCall({ provider: "getprospect", outcome: "miss", units: 0, domain, detail: "email-finder returned no address" });
    return null;
  }
  recordContactApiCall({ provider: "getprospect", outcome: "hit", units: 1, domain });

  return {
    email,
    contactName,
    title: candidate?.companies?.[0]?.position ?? null,
    source: "getprospect",
  };
}
