import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSupplierIdByName } from "@/lib/tenkara-supplier-linker";
import {
  fetchProductSuppliers,
  importYetiKeyConfigured,
  ImportYetiUnavailableError,
  type ImportYetiSupplier,
} from "@/lib/importyeti-client";

// ImportYeti discovery, run in-process. Pulls US-customs suppliers for a material
// (product-suppliers), applies the customs relevance filter, dedups against the
// existing active leads for the (org, material), and stages the survivors as
// source='importyeti' stage='raw' leads. Contact resolution (website + email)
// still happens downstream in Agent 06.
//
// Exclusions passed here are best-effort noise reduction: Agent 04 re-applies
// client do-not-contact / excluded-country suppression before any email is sent.
//
// Disabled (no-op) unless IMPORTYETI_API_KEY is set.

export function importYetiEnabled(): boolean {
  return importYetiKeyConfigured();
}

export interface ImportYetiRequest {
  oaOrgId: string | null;
  materialId: string;
  materialName: string;
  inci: string | null;
  tenkaraOrgId: string | null;
  product?: string; // ImportYeti search term; defaults to materialName
  excludedCountries: string[]; // client-configured country names (best-effort)
  size?: number; // page stride
  page?: number; // 1-based; maps to offset = (page-1)*size to walk deeper
  minMatchingShipments?: number;
  minSpecialization?: number;
  maxLeads?: number;
}

export interface ImportYetiResult {
  ok: boolean;
  received: number;
  inserted: number;
  reason?: string;
  skipped: Record<string, number>;
}

const IY_BASE = "https://www.importyeti.com";
const DEFAULT_MIN_MATCHING = 2;
const DEFAULT_MIN_SPEC = 5;
const DEFAULT_MAX_LEADS = 50;

const normName = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Non-material-supplier denylist: freight forwarders / chartering / logistics /
// customs brokers move goods, they don't make the material — drop them.
const NON_MATERIAL_KEYWORDS = [
  "freight", "forwarder", "forwarders", "forwarding", "chartering", "charterers",
  "logistics", "logistic", "cargo", "shipping", "maritime", "stevedore", "stevedoring",
  "3pl", "courier", "haulage", "trucking", "transport", "transportation",
  "warehousing", "customs broker", "customs brokerage", "supply chain",
  "shipping line", "container line", "shipping agency", "shipping agencies",
  "textile", "textiles", "garment", "apparel", "clothing", "knitting",
  "pet products", "pet food", "pet supplies", "animal feed",
  "injection molding", "plastic molding", "mold making", "die casting",
  "printing", "print shop", "tractor", "machinery", "equipment rental",
];
const NON_MATERIAL_RE = new RegExp(
  "\\b(?:" +
    NON_MATERIAL_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")\\b",
  "i"
);
const nonMaterialReason = (name: string) => {
  const m = NON_MATERIAL_RE.exec(name ?? "");
  return m ? m[0].toLowerCase() : null;
};

const num = (v: unknown): number =>
  (typeof v === "number" && Number.isFinite(v) ? v : Number(v)) || 0;

// ImportYeti uses placeholder strings for unresolved fields — drop them.
const PLACEHOLDER = /missing in source document/i;
const cleanList = (arr: unknown, n: number): string[] =>
  (Array.isArray(arr) ? arr.filter((x) => x && !PLACEHOLDER.test(String(x))) : []).slice(0, n);

function profileUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  const s = String(link).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return `${IY_BASE}${s.startsWith("/") ? "" : "/"}${s}`;
}

// Confidence from the customs signal: specialization (focus on THIS material),
// matching shipment volume, and supplier experience. Bounded 0-1.
function confidenceScore(s: ImportYetiSupplier): number {
  const spec = num(s.specialization); // 0-100
  const matching = num(s.matching_shipments);
  let sc = 0.35;
  sc += Math.min(0.3, (spec / 100) * 0.6); // heavy weight on specialization
  if (matching >= 10) sc += 0.2;
  else if (matching >= 3) sc += 0.1;
  if (num(s.supplier_experience) >= 3) sc += 0.1;
  if (num(s.relevance_score) >= 90) sc += 0.05;
  return Math.min(1, Math.round(sc * 100) / 100);
}

const confidenceHint = (sc: number) => (sc >= 0.75 ? "strong" : sc >= 0.55 ? "medium" : "lead");

function scoutNotes(s: ImportYetiSupplier): string {
  const bits: string[] = [];
  const spec = num(s.specialization);
  if (spec) bits.push(`${spec}% specialized on this product`);
  if (num(s.matching_shipments)) bits.push(`${num(s.matching_shipments)} matching US-customs shipments`);
  if (num(s.total_customers)) bits.push(`${num(s.total_customers)} US customers`);
  const cust = cleanList(s.customer_companies, 5);
  if (cust.length) bits.push(`ships to ${cust.join(", ")}`);
  return `ImportYeti (US customs) — ${bits.join("; ")}`;
}

// Existing active supplier names for the (org, material). Paginated: a single
// PostgREST select silently caps at 1000 rows, which would degrade the dedup on
// well-covered materials and re-stage suppliers already in flight.
async function loadExistingNames(
  admin: SupabaseClient,
  orgId: string,
  materialId: string
): Promise<Set<string>> {
  const seen = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("leads_in_flight")
      .select("supplier_name")
      .eq("org_id", orgId)
      .eq("material_id", materialId)
      .eq("status", "active")
      .range(from, from + 999);
    if (error) throw new Error(`dedup query failed: ${error.message}`);
    for (const r of data ?? []) {
      const nm = normName(r.supplier_name);
      if (nm) seen.add(nm);
    }
    if (!data || data.length < 1000) break;
  }
  return seen;
}

export async function runImportYetiDiscovery(
  admin: SupabaseClient,
  req: ImportYetiRequest,
  agentRunId: string
): Promise<ImportYetiResult> {
  const empty = { received: 0, inserted: 0, skipped: {} as Record<string, number> };
  if (!importYetiEnabled()) return { ok: false, reason: "not_configured", ...empty };
  if (!req.oaOrgId) return { ok: false, reason: "no_org", ...empty };

  const size = req.size && req.size > 0 ? req.size : 10;
  const page = req.page && req.page > 0 ? req.page : 1;
  const minMatching = req.minMatchingShipments ?? DEFAULT_MIN_MATCHING;
  const minSpec = req.minSpecialization ?? DEFAULT_MIN_SPEC;
  const maxLeads = req.maxLeads ?? DEFAULT_MAX_LEADS;

  const { suppliers } = await fetchProductSuppliers(req.product || req.materialName, {
    pageSize: size,
    offset: (page - 1) * size,
  });
  if (!suppliers.length) {
    return { ok: true, reason: "no_results", received: 0, inserted: 0, skipped: {} };
  }

  const excludedCountries = new Set(
    (req.excludedCountries ?? []).map((c) => String(c).toUpperCase())
  );
  const seenNames = await loadExistingNames(admin, req.oaOrgId, req.materialId);

  // Material keywords for product_description matching: significant (3+ char)
  // words from the material name and INCI.
  const materialWords = new Set<string>();
  for (const raw of [req.materialName, req.inci].filter(Boolean) as string[]) {
    for (const w of raw.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
      if (w.length >= 3) materialWords.add(w);
    }
  }
  const productDescriptionMatchesMaterial = (descriptions: unknown): boolean => {
    if (!materialWords.size) return true;
    const descs = cleanList(descriptions, 30);
    if (!descs.length) return true; // no product_description = can't check, let through
    const joined = descs.join(" ").toLowerCase();
    for (const w of materialWords) if (joined.includes(w)) return true;
    return false;
  };

  let skipDup = 0,
    skipCountry = 0,
    skipNoName = 0,
    skipRelevance = 0,
    skipNonMaterial = 0,
    skipProductMismatch = 0;
  const kept: { s: ImportYetiSupplier; name: string; country: string | null }[] = [];

  for (const s of suppliers) {
    const name = (s.supplier_name ?? "").trim();
    if (!name) { skipNoName++; continue; }
    if (nonMaterialReason(name)) { skipNonMaterial++; continue; }
    const country = (s.supplier_country_code ?? "").toString().trim().toUpperCase() || null;
    if (country && excludedCountries.has(country)) { skipCountry++; continue; }
    // Relevance filter: skip suppliers that barely touch this material.
    if (num(s.matching_shipments) < minMatching || num(s.specialization) < minSpec) {
      skipRelevance++;
      continue;
    }
    // Catches companies whose shipments are tagged generically but who actually
    // deal in unrelated products (fruit farms, textile, pet products).
    if (!productDescriptionMatchesMaterial(s.product_description)) {
      skipProductMismatch++;
      continue;
    }
    const nm = normName(name);
    if (nm && seenNames.has(nm)) { skipDup++; continue; }
    if (nm) seenNames.add(nm);
    kept.push({ s, name, country });
  }

  // Rank by specialization then weight (volume), cap at maxLeads.
  kept.sort(
    (a, b) =>
      num(b.s.specialization) - num(a.s.specialization) || num(b.s.weight) - num(a.s.weight)
  );
  let skipCap = 0;
  if (kept.length > maxLeads) {
    skipCap = kept.length - maxLeads;
    kept.length = maxLeads;
  }

  const skipped = {
    duplicate: skipDup,
    excludedCountry: skipCountry,
    noName: skipNoName,
    belowRelevance: skipRelevance,
    nonMaterial: skipNonMaterial,
    productMismatch: skipProductMismatch,
    overCap: skipCap,
  };

  if (!kept.length) {
    return { ok: true, reason: "all_filtered", received: suppliers.length, inserted: 0, skipped };
  }

  const rows = [];
  for (const { s, name, country } of kept) {
    const sc = confidenceScore(s);
    const link = profileUrl(s.supplier_link);
    rows.push({
      org_id: req.oaOrgId,
      supplier_name: name,
      supplier_id: await resolveSupplierIdByName(name),
      material_name: req.materialName,
      material_id: req.materialId,
      stage: "raw" as const,
      status: "active" as const,
      source: "importyeti" as const,
      payload: {
        inci_name: req.inci ?? null,
        trade_name: null,
        supplier_website: null, // ImportYeti gives none — resolve before outreach
        supplier_contact_email: null,
        supplier_phone: null,
        supplier_country: country,
        supplier_role: null,
        hq_address: s.supplier_address ?? null,
        supplier_background: null,
        pack_sizes_pricing: null,
        grades_offered: null,
        certifications: null,
        moq: null,
        site_type: null,
        confidence_hint: confidenceHint(sc),
        completeness_score: 0.2, // low: no website/email/contact yet
        needs_contact_resolution: true, // flag for the website/email gap
        source_url: link,
        source_citations: link ? [link] : [],
        scout_notes: scoutNotes(s),
        importyeti: {
          matching_shipments: num(s.matching_shipments),
          total_shipments: num(s.supplier_total_shipments),
          specialization: num(s.specialization),
          relevance_score: num(s.relevance_score),
          supplier_experience: num(s.supplier_experience),
          weight: num(s.weight),
          total_customers: num(s.total_customers),
          top_customers: cleanList(s.customer_companies, 15),
          top_products: cleanList(s.product_description, 15),
          profile_link: link,
        },
        tenkara_org_id: req.tenkaraOrgId ?? null,
      },
      confidence_score: sc,
      agent_run_id: agentRunId,
    });
  }

  const { data: inserted, error } = await admin
    .from("leads_in_flight")
    .insert(rows)
    .select("id");
  if (error) throw new Error(`lead insert failed: ${error.message}`);

  return {
    ok: true,
    received: suppliers.length,
    inserted: inserted?.length ?? 0,
    skipped,
  };
}

export { ImportYetiUnavailableError };
