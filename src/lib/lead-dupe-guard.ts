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
//
// Four shapes reach that outcome, all checked here:
//   1. supplier_on_domain — the client already has a supplier on this domain
//   2. lead_pair          — two of our own leads are the same company, and
//                           nothing exists on that domain yet, so promoting
//                           both creates the pair from scratch
//   3. name_variant       — the name is a longer or shorter form of an existing
//                           supplier's ("Buckman" / "Buckman Laboratories")
//   4. email_domain       — the website differs but the contact email is on an
//                           existing supplier's domain

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
 * True when a domain and a company name are the same brand.
 *
 * This is what separates a company domain from a directory. Five rows on
 * tronox.com are all named "Tronox …", so the domain identifies the company.
 * Thirty rows on goldsupplier.com are named after thirty different sellers and
 * none is called "Goldsupplier", so the domain identifies a platform and its
 * rows are not duplicates of each other.
 *
 * Containment alone is too strict in both directions: kimica-algin.com is
 * "Kimica", and lyondellbasell.com holds "Lyondell Chemie Nederland". A shared
 * five-character prefix covers those without letting a directory in, because a
 * directory's brand shares no prefix with its sellers' names.
 */
export function brandRelates(domain: string, name: string): boolean {
  const brand = domain.split(".")[0].replace(/[^a-z0-9]/g, "");
  const flat = name.replace(/\s+/g, "");
  if (brand.length < 3 || !flat) return false;
  if (flat.includes(brand)) return true;
  if (flat.length >= 4 && brand.includes(flat)) return true;
  let i = 0;
  while (i < Math.min(brand.length, flat.length) && brand[i] === flat[i]) i++;
  return i >= 5;
}

// Industry words that are a whole supplier name in Tenkara on their own
// ("Enterprises", "Spices"). Every third supplier is an "X Enterprises", so
// treating the bare word as the parent company matches all of them.
const GENERIC_NAME_TOKENS = new Set([
  "enterprises", "enterprise", "spices", "spice", "foods", "food", "nutrition", "nutraceuticals",
  "chemicals", "chemical", "dehydrates", "ingredients", "industries", "industry", "pharma", "agro",
  "international", "products", "trading", "traders", "exports", "export", "imports", "bio", "biotech",
  "labs", "laboratories", "herbs", "naturals", "extracts", "solutions", "specialties", "supplies",
]);

export interface GuardLead {
  id: string;
  org_id: string | null;
  supplier_id?: string | null;
  supplier_name: string | null;
  material_id: string | null;
  material_name: string | null;
  stage: string;
  payload: Record<string, any> | null;
}

export interface GuardSupplier {
  id?: string | number | null;
  name: string | null;
  website: string | null;
  is_marketplace: boolean;
}

export type DupeKind = "supplier_on_domain" | "lead_pair" | "name_variant" | "email_domain";

export interface DupeVerdict {
  lead: GuardLead;
  /** The domain the match was made on (website, or the contact email's domain). */
  domain: string;
  /** What it looks like a duplicate of, as written. */
  existingNames: string[];
  kind: DupeKind;
  /** One line naming the shape, for the case and the review row. */
  reason: string;
  /**
   * The name to adopt if the operator says it is the same company. Renaming the
   * lead to it makes Tenkara's own name gate link the lead to the existing
   * supplier instead of creating a second one, which keeps the material.
   */
  canonicalName: string | null;
}

/**
 * Marketplace listings are out of scope for this guard.
 *
 * A marketplace host deliberately carries one supplier row per principal whose
 * goods are sold there ("Knowde", "Knowde Roquette store", "Knowde Thai Wah
 * listing"), so a name collision on that host is the intended shape, not a
 * duplicate. Only direct suppliers, where one company means one row, are
 * checked. Mirrors `isMarketplaceLead` in tenkara-platform.
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

function leadEmailDomain(payload: Record<string, any> | null): string | null {
  const email = (payload ?? {}).supplier_contact_email;
  if (!email || typeof email !== "string" || !email.includes("@")) return null;
  return registrableDomain(email.split("@").pop());
}

/**
 * True when the NAME itself declares which side of the split it is.
 *
 * Tenkara marks the deliberate pair in the name ("Univar Solutions - Marketplace"
 * / "Colonial Chemical - Nonmarketplace"). Those leads often carry no site_type
 * or supplier_role at all, so the payload check above cannot see them and they
 * read as an ordinary second company on the same domain. The qualifier is the
 * whole point of the row, so it is the reliable signal here.
 */
function nameDeclaresSplit(raw: string | null | undefined): boolean {
  return /\b(non[\s-]?marketplace|marketplace)\b/i.test(raw ?? "");
}

/** Index of a domain's suppliers: normalized name → the name as Tenkara holds it. */
type NameIndex = Map<string, string>;

/** The shortest name on the domain that shares its brand: the parent company. */
function parentName(domain: string, names: NameIndex): string | null {
  let best: string | null = null;
  for (const [norm, raw] of names) {
    if (!brandRelates(domain, norm)) continue;
    if (best === null || norm.length < normalizeName(best).length) best = raw;
  }
  return best ?? [...names.values()][0] ?? null;
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
  const supplierNames: NameIndex = new Map();
  // Marketplace rows are in `supplierNames` because Tenkara's name gate counts
  // them, but never a match target: "Knowde - Galaxy Surfactants" is the Knowde
  // listing, not the Galaxy Surfactants company.
  const directNames: NameIndex = new Map();
  const namesOnHost = new Map<string, NameIndex>();
  for (const s of suppliers) {
    const name = normalizeName(s.name);
    if (name && !supplierNames.has(name)) supplierNames.set(name, s.name ?? name);
    if (s.is_marketplace) continue;
    if (name && !directNames.has(name)) directNames.set(name, s.name ?? name);
    const host = registrableDomain(s.website);
    if (!host || !name) continue;
    if (!namesOnHost.has(host)) namesOnHost.set(host, new Map());
    const index = namesOnHost.get(host)!;
    if (!index.has(name)) index.set(name, s.name ?? name);
  }

  // Tenkara measures ambiguity on the lead side too, so we have to as well.
  const leadNamesOnHost = new Map<string, Set<string>>();
  for (const l of leads) {
    if (leadIsMarketplace(l.payload)) continue;
    const name = normalizeName(l.supplier_name);
    const host = registrableDomain(leadWebsite(l.payload));
    if (!host || !name) continue;
    if (!leadNamesOnHost.has(host)) leadNamesOnHost.set(host, new Set());
    leadNamesOnHost.get(host)!.add(name);
  }

  // Shape 2 needs one lead per domain to survive, or the supplier never gets
  // created at all. The keeper is the shortest name (the plain company name,
  // before a division or a legal form is tacked on), id as a stable tie-break.
  const keeperByHost = new Map<string, { norm: string; raw: string }>();
  for (const [host, names] of leadNamesOnHost) {
    if (namesOnHost.has(host)) continue;
    const related = [...names].filter((n) => brandRelates(host, n));
    if (related.length < 2) continue;
    const candidates = leads
      .filter((l) => {
        const n = normalizeName(l.supplier_name);
        return related.includes(n) && registrableDomain(leadWebsite(l.payload)) === host;
      })
      .sort((a, b) => {
        const an = normalizeName(a.supplier_name);
        const bn = normalizeName(b.supplier_name);
        return an.length - bn.length || String(a.id).localeCompare(String(b.id));
      });
    const keeper = candidates[0];
    if (keeper) keeperByHost.set(host, { norm: normalizeName(keeper.supplier_name), raw: keeper.supplier_name ?? "" });
  }

  const out: DupeVerdict[] = [];
  for (const lead of leads) {
    if (leadIsMarketplace(lead.payload) || nameDeclaresSplit(lead.supplier_name)) continue;
    const name = normalizeName(lead.supplier_name);
    if (!name) continue;

    // Tenkara's name gate already catches this one; it is not going to duplicate.
    if (supplierNames.has(name)) continue;

    const host = registrableDomain(leadWebsite(lead.payload));

    // 1. The client already has a supplier on this domain.
    const existing = host ? namesOnHost.get(host) : undefined;
    if (host && existing?.size) {
      // Tenkara's host gate is live here and will do the right thing.
      const gateHolds = existing.size === 1 && (leadNamesOnHost.get(host)?.size ?? 0) === 1;
      if (gateHolds) continue;
      // A directory host carries unrelated sellers; those are not duplicates.
      // Both sides have to be the domain's own brand: the lead, so it is not
      // another seller merely listed there, and at least one existing row, so
      // the domain identifies a company rather than a platform.
      const relatedExisting = [...existing.keys()].filter((n) => brandRelates(host, n));
      if (!relatedExisting.length || !brandRelates(host, name)) continue;
      out.push({
        lead,
        domain: host,
        existingNames: relatedExisting.map((n) => existing.get(n)!),
        kind: "supplier_on_domain",
        reason: `Already a supplier on ${host}`,
        canonicalName: parentName(host, existing),
      });
      continue;
    }

    // 2. Nothing exists on this domain yet, but two of our own leads on it are
    //    the same company, so promoting both is what creates the pair.
    const keeper = host ? keeperByHost.get(host) : undefined;
    if (keeper && keeper.norm !== name && brandRelates(host!, name)) {
      out.push({
        lead,
        domain: host!,
        existingNames: [keeper.raw],
        kind: "lead_pair",
        reason: `Another lead on ${host} is the same company`,
        canonicalName: keeper.raw,
      });
      continue;
    }

    // 3. A longer or shorter form of an existing supplier's name, on the
    //    company's own domain ("Buckman" / "Buckman Laboratories").
    if (host && brandRelates(host, name)) {
      const tokens = new Set(name.split(" ").filter(Boolean));
      let variant: string | null = null;
      const brand = host.split(".")[0].replace(/[^a-z0-9]/g, "");
      for (const [supplierNorm, supplierRaw] of directNames) {
        const other = new Set(supplierNorm.split(" ").filter(Boolean));
        if (!other.size || supplierNorm === name) continue;
        const subset = [...other].every((t) => tokens.has(t)) || [...tokens].every((t) => other.has(t));
        if (!subset) continue;
        const shorter = other.size < tokens.size ? other : tokens;
        if (shorter.size === 1) {
          const only = [...shorter][0];
          // "Enterprises" as a whole supplier name is not the parent of every
          // "X Enterprises" lead, and elementalenzymes.com is not "Enzymes".
          // A bare word only counts when it IS the domain: buckman.com/Buckman.
          if (GENERIC_NAME_TOKENS.has(only) || only !== brand) continue;
        }
        if (!brandRelates(host, supplierNorm)) continue;
        variant = supplierRaw;
        break;
      }
      if (variant) {
        out.push({
          lead,
          domain: host,
          existingNames: [variant],
          kind: "name_variant",
          reason: `Same name as an existing supplier, longer or shorter`,
          canonicalName: variant,
        });
        continue;
      }
    }

    // 4. Different website, but the contact email is on an existing supplier's
    //    domain. Catches a regional site or a rebranded URL.
    const emailHost = leadEmailDomain(lead.payload);
    const onEmailHost = emailHost ? namesOnHost.get(emailHost) : undefined;
    if (emailHost && onEmailHost?.size && !onEmailHost.has(name) && brandRelates(emailHost, name)) {
      out.push({
        lead,
        domain: emailHost,
        existingNames: [...onEmailHost.values()],
        kind: "email_domain",
        reason: `Contact email is on ${emailHost}, an existing supplier's domain`,
        canonicalName: parentName(emailHost, onEmailHost),
      });
    }
  }
  return out;
}
