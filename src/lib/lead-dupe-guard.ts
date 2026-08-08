// Catches a lead that is about to become a duplicate supplier in Tenkara.
//
// Tenkara pulls our leads every two minutes and promotes anything sitting at
// `enriched` or `ready_for_outreach` into a `suppliers` row, hourly. Its own
// guard skips a lead whose name already exists, and skips one whose website
// host already exists — but it turns that second check off as soon as a host
// carries more than one distinct name, because on a directory host (alibaba,
// linkedin, panjiva) the rows really are different companies.
//
// A duplicate is precisely a host carrying more than one name, so the check
// disables itself on the case it exists to catch: tronox.com already holding
// "Tronox" lets "Tronox France" and "Tronox Pigment Bunbury" straight through.
//
// We cannot fix that gate (it lives in tenkara-platform and we are read-only
// against it), but we can stop feeding it. Parking the lead at a stage Tenkara
// does not promote keeps the duplicate from ever being created.

/** Stages Tenkara will promote. Mirrors FILTERED_LEAD_STAGES in tenkara-platform. */
export const PROMOTABLE_STAGES = ["enriched", "ready_for_outreach"] as const;

// Multi-part public suffixes we actually see on supplier sites. Without these,
// "avh.co.in" reduces to "co.in" and every Indian supplier looks like one company.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.il", "co.in", "co.th", "co.id",
  "com.au", "com.br", "com.cn", "com.mx", "com.tr", "com.sg", "com.my", "com.hk", "com.tw", "com.ar",
  "com.co", "com.pe", "com.ph", "com.vn", "com.pk", "com.eg", "com.sa", "com.ua", "com.ng", "com.bd",
]);

/** Registrable domain, lowercased. Null when the URL is unusable. */
export function registrableDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = String(raw).trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split(/[/?#]/)[0];
  host = host.split("@").pop() ?? host;
  host = host.split(":")[0].replace(/\.+$/, "");
  if (!host || !host.includes(".")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const parts = host.split(".").filter(Boolean);
  const want = MULTI_PART_SUFFIXES.has(parts.slice(-2).join(".")) ? 3 : 2;
  if (parts.length < want) return null;
  return parts.slice(-want).join(".");
}

const LEGAL_SUFFIXES =
  /\b(inc|incorporated|llc|ltd|limited|co|corp|corporation|company|gmbh|ag|sa|srl|bv|nv|plc|pvt|pte|sdn|bhd|spa|oy|ab|as|aps|group|holdings)\b/g;

/**
 * Lowercase, punctuation and legal suffixes removed.
 *
 * Must stay in step with `normalizeSupplierName` in tenkara-platform: this is
 * how we predict whether Tenkara's name gate will fire, so a looser rule here
 * makes us think a lead is safe when it is not.
 */
export function normalizeName(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the domain's own brand shows up in at least one name on it.
 *
 * This is what separates a company domain from a directory. Five rows on
 * tronox.com are all named "Tronox …", so the domain identifies the company.
 * Thirty rows on goldsupplier.com are named after thirty different sellers and
 * none is called "Goldsupplier", so the domain identifies a platform and its
 * rows are not duplicates of each other. Without this the check fires on 1,183
 * leads, mostly bloomberg.com and linkedin.com; with it, on 232.
 */
function brandAppearsIn(domain: string, names: Iterable<string>): boolean {
  const brand = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (brand.length < 3) return false;
  for (const n of names) if (n.replace(/\s+/g, "").includes(brand)) return true;
  return false;
}

export interface GuardLead {
  id: string;
  org_id: string | null;
  supplier_name: string | null;
  material_id: string | null;
  material_name: string | null;
  stage: string;
  payload: Record<string, any> | null;
}

export interface GuardSupplier {
  name: string | null;
  website: string | null;
  is_marketplace: boolean;
}

export interface DupeVerdict {
  lead: GuardLead;
  /** Registrable domain shared with the existing supplier. */
  domain: string;
  /** Existing Tenkara supplier names on that domain, for the operator to read. */
  existingNames: string[];
}

/**
 * A marketplace listing and a direct relationship for one company are kept as
 * two suppliers on purpose, so a lead only collides with a supplier of its own
 * type. Mirrors `isMarketplaceLead` in tenkara-platform.
 */
export function leadIsMarketplace(payload: Record<string, any> | null): boolean {
  const p = payload ?? {};
  const siteType = String(p.site_type ?? "").toUpperCase();
  if (siteType === "M" || siteType === "MS") return true;
  return String(p.supplier_role ?? "").toUpperCase() === "MARKETPLACE";
}

function leadWebsite(payload: Record<string, any> | null): string | null {
  return (payload ?? {}).supplier_website ?? null;
}

/**
 * Leads that will create a duplicate supplier on Tenkara's next promote run.
 *
 * `suppliers` must be every Tenkara supplier already linked to this org, and
 * `leads` every promotable lead for it — both are needed whole, because the
 * gate we are predicting counts distinct names per host across the full set.
 */
export function findDuplicateBoundLeads(
  leads: GuardLead[],
  suppliers: GuardSupplier[]
): DupeVerdict[] {
  const typeKey = (host: string, marketplace: boolean) => `${marketplace ? "m" : "d"}::${host}`;

  const supplierNames = new Set<string>();
  const namesOnHost = new Map<string, Set<string>>();
  for (const s of suppliers) {
    const name = normalizeName(s.name);
    if (name) supplierNames.add(name);
    const host = registrableDomain(s.website);
    if (!host || !name) continue;
    const k = typeKey(host, s.is_marketplace);
    if (!namesOnHost.has(k)) namesOnHost.set(k, new Set());
    namesOnHost.get(k)!.add(name);
  }

  // Tenkara measures ambiguity on the lead side too, so we have to as well.
  const leadNamesOnHost = new Map<string, Set<string>>();
  for (const l of leads) {
    const name = normalizeName(l.supplier_name);
    const host = registrableDomain(leadWebsite(l.payload));
    if (!host || !name) continue;
    const k = typeKey(host, leadIsMarketplace(l.payload));
    if (!leadNamesOnHost.has(k)) leadNamesOnHost.set(k, new Set());
    leadNamesOnHost.get(k)!.add(name);
  }

  const out: DupeVerdict[] = [];
  for (const lead of leads) {
    const name = normalizeName(lead.supplier_name);
    const host = registrableDomain(leadWebsite(lead.payload));
    if (!name || !host) continue;

    // Tenkara's name gate already catches this one; it is not going to duplicate.
    if (supplierNames.has(name)) continue;

    const k = typeKey(host, leadIsMarketplace(lead.payload));
    const existing = namesOnHost.get(k);
    if (!existing?.size) continue;

    // Tenkara's host gate is live here and will do the right thing.
    const gateHolds = existing.size === 1 && (leadNamesOnHost.get(k)?.size ?? 0) === 1;
    if (gateHolds) continue;

    // A directory host carries unrelated sellers; those are not duplicates.
    if (!brandAppearsIn(host, [...existing, name])) continue;
    // …and the lead itself has to be one of the company's own names, not another
    // seller that merely happens to be listed on the same corporate domain.
    if (!brandAppearsIn(host, [name])) continue;

    out.push({ lead, domain: host, existingNames: [...existing].sort() });
  }
  return out;
}
