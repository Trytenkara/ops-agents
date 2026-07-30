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

async function gpRequest(path: string, options: RequestInit): Promise<any | null> {
  const allowed =
    (path.startsWith("/public/v1/insights/contacts?") && options.method === "POST") ||
    (path.startsWith("/v2/email-finder?") && options.method === "GET");
  if (!allowed || !isGetProspectConfigured()) return null;

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
    if (!response.ok) return null;
    return await response.json();
  } catch {
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
  const search = await gpRequest("/public/v1/insights/contacts?pageSize=10&pageNumber=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(searchBody),
  });
  const candidates: any[] = Array.isArray(search?.data) ? search.data : [];
  if (!candidates.length) return null;

  const candidate = [...candidates]
    .filter((row) => row?.firstName && row?.lastName)
    .sort((a, b) => candidateScore(b) - candidateScore(a))[0];
  if (!candidate) return null;

  const contactName = `${candidate.firstName} ${candidate.lastName}`.trim();
  const finderDomain = domain || candidate?.companies?.[0]?.company?.domain || null;
  if (!finderDomain) return null;

  const query = new URLSearchParams({
    domain: finderDomain,
    full_name: contactName,
    api_key: API_KEY,
  });
  const found = await gpRequest(`/v2/email-finder?${query.toString()}`, { method: "GET" });
  const email = String(found?.email ?? found?.data?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return null;

  return {
    email,
    contactName,
    title: candidate?.companies?.[0]?.position ?? null,
    source: "getprospect",
  };
}
