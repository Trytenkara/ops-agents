import { tenkaraQuery } from "./tenkara-readonly";

// Per-client sourcing exclusions, configured by the client in Tenkara's
// settings (public.user_supplier_settings, keyed by organization_id):
//   - dnc_suppliers:    jsonb[] of { name, website } — the do-not-contact list.
//   - excluded_material_countries / excluded_sourcing.countries — countries the
//     client refuses to source from.
// We read these read-only and suppress matching suppliers so neither lead
// generation (Agent 03) nor cold outreach (Agent 04) ever contacts them.
//
// Companies carry no Tenkara supplier_id here, so matching is by normalized
// company name OR website host. This is exact-after-normalization; typo-variant
// (fuzzy) matching is a separate follow-up.

export interface SourcingExclusions {
  dncNames: Set<string>; // normalized company names
  dncHosts: Set<string>; // website hosts (lowercased, no www.)
  excludedCountries: Set<string>; // lowercased country names
  raw: { companies: number; countries: number };
}

const EMPTY: SourcingExclusions = {
  dncNames: new Set(),
  dncHosts: new Set(),
  excludedCountries: new Set(),
  raw: { companies: 0, countries: 0 },
};

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = url.includes("://") ? url : `https://${url}`;
    return new URL(u).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,/#!$%^*;:{}=\-_`~()'"]/g, " ")
    .replace(/\b(inc|incorporated|llc|ltd|limited|co|corp|corporation|company|gmbh|sa|srl|bv|plc|pvt|pte|group)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normCountry(c: string | null | undefined): string {
  return (c ?? "").toLowerCase().trim();
}

interface SettingsRow {
  dnc_suppliers: Array<{ name?: string; website?: string }> | null;
  excluded_material_countries: string[] | null;
  excluded_packaging_countries: string[] | null;
  excluded_sourcing: { countries?: string[] } | null;
}

// Fetch the client's sourcing exclusions for one Tenkara org. Returns empty
// sets (never throws to callers that prefer fail-open) only when explicitly
// caught upstream — this function itself propagates query errors so callers
// can decide fail-open vs fail-closed.
export async function getSourcingExclusions(orgTenkaraId: string | null | undefined): Promise<SourcingExclusions> {
  if (!orgTenkaraId) return EMPTY;
  const rows = await tenkaraQuery<SettingsRow>(
    `select dnc_suppliers, excluded_material_countries, excluded_packaging_countries, excluded_sourcing
       from public.user_supplier_settings
      where organization_id = $1::uuid
      limit 1`,
    [orgTenkaraId]
  );
  const row = rows[0];
  if (!row) return EMPTY;

  const dncNames = new Set<string>();
  const dncHosts = new Set<string>();
  for (const c of row.dnc_suppliers ?? []) {
    const n = normalizeCompanyName(c?.name);
    if (n) dncNames.add(n);
    const h = hostOf(c?.website);
    if (h) dncHosts.add(h);
  }

  // Country exclusions: material-sourcing leads, so we honor the material
  // exclusions plus the general excluded_sourcing list. Packaging-only
  // exclusions are intentionally left out to avoid over-suppressing material
  // suppliers.
  const excludedCountries = new Set<string>();
  for (const c of row.excluded_material_countries ?? []) {
    const v = normCountry(c);
    if (v) excludedCountries.add(v);
  }
  for (const c of row.excluded_sourcing?.countries ?? []) {
    const v = normCountry(c);
    if (v) excludedCountries.add(v);
  }

  return {
    dncNames,
    dncHosts,
    excludedCountries,
    raw: { companies: dncNames.size + dncHosts.size, countries: excludedCountries.size },
  };
}

export interface SourcingExclusionsDetail {
  companies: Array<{ name: string | null; website: string | null }>;
  countries: string[];
}

// Display-oriented read: the raw do-not-contact companies and excluded
// countries a client configured, for surfacing on the client profile so ops can
// confirm what sourcing/outreach is suppressing.
export async function getSourcingExclusionsDetail(
  orgTenkaraId: string | null | undefined
): Promise<SourcingExclusionsDetail> {
  if (!orgTenkaraId) return { companies: [], countries: [] };
  const rows = await tenkaraQuery<SettingsRow>(
    `select dnc_suppliers, excluded_material_countries, excluded_packaging_countries, excluded_sourcing
       from public.user_supplier_settings
      where organization_id = $1::uuid
      limit 1`,
    [orgTenkaraId]
  );
  const row = rows[0];
  if (!row) return { companies: [], countries: [] };
  const companies = (row.dnc_suppliers ?? [])
    .map((c) => ({ name: c?.name ?? null, website: c?.website ?? null }))
    .filter((c) => c.name || c.website);
  const countrySet = new Set<string>();
  for (const c of row.excluded_material_countries ?? []) if (c?.trim()) countrySet.add(c.trim());
  for (const c of row.excluded_sourcing?.countries ?? []) if (c?.trim()) countrySet.add(c.trim());
  return { companies, countries: Array.from(countrySet) };
}

export interface ExclusionCheckInput {
  name?: string | null;
  website?: string | null;
  country?: string | null;
}

// Returns a suppression reason if the supplier matches the client's DNC company
// list (by host or normalized name) or sits in an excluded country; else null.
export function exclusionReason(s: ExclusionCheckInput, ex: SourcingExclusions): string | null {
  const h = hostOf(s.website);
  if (h && ex.dncHosts.has(h)) return "dnc_company";
  const n = normalizeCompanyName(s.name);
  if (n && ex.dncNames.has(n)) return "dnc_company";
  const c = normCountry(s.country);
  if (c && ex.excludedCountries.has(c)) return "excluded_country";
  return null;
}
