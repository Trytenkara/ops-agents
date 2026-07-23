import { createHmac } from "node:crypto";

// ImportYeti discovery bridge. Mirrors ./sourceready.ts: Agent 03 fires a signed
// webhook to a Gamut agent that holds the ImportYeti API key; that agent pulls
// US-customs suppliers for the material (product-suppliers), stages them into
// leads_in_flight with source='importyeti' (see the importyeti-ingest skill),
// then resolves each supplier's website + RFQ contact (importyeti-resolve-contacts
// skill) so the leads are contactable.
//
// Fire-and-forget: the leads land out-of-band a short time after the run, then
// flow through the normal Agent 06 enrichment -> Agent 04 outreach path. Agent 04
// re-applies client do-not-contact / excluded-country suppression before any email
// is sent, so exclusions passed here are best-effort noise reduction, not the
// authoritative gate.
//
// Disabled (no-op) unless BOTH env vars are set, so this is inert until configured
// in the Vercel project.

const URL_ENV = "IMPORTYETI_WEBHOOK_URL";
const SECRET_ENV = "IMPORTYETI_WEBHOOK_SECRET";

export function importYetiEnabled(): boolean {
  return !!(process.env[URL_ENV] && process.env[SECRET_ENV]);
}

export interface ImportYetiRequest {
  oaOrgId: string | null;
  materialId: string;
  materialName: string;
  inci: string | null;
  tenkaraOrgId: string | null;
  product?: string; // ImportYeti search term; webhook defaults to materialName
  excludedCountries: string[]; // client-configured country names (best-effort)
  dryRun?: boolean;
}

// POST a signed discovery request. Resolves to true on a 2xx acceptance.
// Never throws — discovery is auxiliary and must not break the run.
export async function fireImportYetiDiscovery(req: ImportYetiRequest): Promise<boolean> {
  const url = process.env[URL_ENV];
  const secret = process.env[SECRET_ENV];
  if (!url || !secret) return false;

  const body = JSON.stringify(req);
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url.startsWith("http") ? url : `https://${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-importyeti-signature": signature },
      body,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
