import { tenkaraQuery } from "./tenkara-readonly";

// Per-client vendor-qualification requirements, configured by the client in
// Tenkara (Client Settings → Sourcing Rules). We read them to (a) ask suppliers
// for the requested documents in the reply follow-up chain, and (b) surface the
// qualification checklist on the Platform Extraction tab ("The bench").
//
// Tenkara split these out of the two user_supplier_settings jsonb blobs
// (pre_order_requirements / post_order_requirements, both now dropped) into
// three normalized tables: supplier_requirements holds one row per org per
// order_type, with certifications hanging off it via
// supplier_requirement_certifications and its required-certification children.
//
// The split also collapsed the two jsonb shapes that used to coexist in the
// wild — the old nested `document_flags` variant is gone, so each group now has
// exactly one place to read from. Read-only; Tenkara is never written.

export type RequirementPhase = "pre_order" | "post_order";
export type RequirementKind = "document" | "sample" | "certification" | "statement" | "testing" | "spec";

export interface RequirementItem {
  key: string;
  label: string;
  kind: RequirementKind;
  requested: boolean; // supplier is asked to provide this
  dealbreaker: boolean; // failing it disqualifies the vendor
  phase: RequirementPhase;
  detail: string | null; // e.g. "7 oz sample", "min 3% shelf life"
  askable: boolean; // belongs in the supplier document ask (excludes pure specs)
}

function asBool(v: any): boolean {
  return v === true;
}

// Certification ids are slugs from a static catalog that lives in Tenkara's
// source (shared/types/constants/certifications.ts), not in a table — there is
// nothing to join to. Humanize the slug rather than mirroring that catalog here:
// a copy would drift silently every time Tenkara adds an entry, and a slug it
// had not yet learned would render as a blank line in the supplier ask.
const CERT_ACRONYMS = new Set([
  "usda", "haccp", "iso", "iec", "gmp", "cgmp", "gfsi", "brc", "sqf", "fssc",
  "ifs", "fda", "nsf", "ansi", "astm", "iatf", "ohsas", "reach", "rohs", "rspo",
  "gots", "msc", "eu", "us", "uk",
]);

function certLabel(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((w) => (CERT_ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function documentNames(documents: any): string[] {
  const docs: any[] = Array.isArray(documents) ? documents : [];
  return docs
    .map((d) => (typeof d === "string" ? d : d?.name ?? d?.label ?? null))
    .filter((n): n is string => !!n && n.trim().length > 0);
}

// A custom group is a single jsonb column: { documents?, custom_requests?,
// is_dealbreaker? }. custom_documentation and custom_testing carry no
// is_dealbreaker of their own, so theirs reads false.
function readGroup(group: any): { requested: boolean; dealbreaker: boolean; names: string[] } {
  const names = documentNames(group?.documents);
  const requested = asBool(group?.custom_requests) || names.length > 0;
  const dealbreaker = asBool(group?.is_dealbreaker);
  return { requested, dealbreaker, names };
}

// Certifications span two child tables: free-text `documents` on the
// certifications row, plus one required_certifications row per catalog
// certification. Both feed the supplier ask.
function readCertifications(row: RequirementsRow): { requested: boolean; dealbreaker: boolean; names: string[] } {
  const certs = Array.isArray(row.required_certs) ? row.required_certs : [];
  // is_required defaults true in the table, so an explicitly unrequired entry is
  // the only thing this drops. Both the names and the dealbreaker flag read from
  // this same list: an unrequired certification that still carries
  // is_dealbreaker must not mark the group, because its own name never reaches
  // `names` and dealbreakerCertNames() would then hand the leads filter the
  // OTHER certifications as if the client had flagged them.
  const required = certs.filter((c) => c.is_required !== false);
  const names = [
    ...documentNames(row.cert_documents),
    ...required.map((c) => certLabel(c.certification_id)),
  ];
  const requested = asBool(row.cert_custom_requests) || names.length > 0;
  // Before the split this was one group-level flag; it is per-certification now,
  // so the group counts as a dealbreaker when any required certification is one.
  // That keeps dealbreakerCertNames()'s "supplier must hold ALL of them" reading
  // intact — see the note on that function.
  const dealbreaker = required.some((c) => c.is_dealbreaker === true);
  return { requested, dealbreaker, names };
}

// Normalize one supplier_requirements row (pre or post) into a flat item list.
function parseRequirements(row: RequirementsRow): RequirementItem[] {
  const phase = row.order_type;
  const items: RequirementItem[] = [];

  // Standard documents.
  const stdDocs: Array<[string, string, boolean, boolean]> = [
    ["coa", "Certificate of Analysis", asBool(row.coa_required), asBool(row.coa_dealbreaker)],
    ["sds", "Safety Data Sheet", asBool(row.sds_required), asBool(row.sds_dealbreaker)],
    ["tds", "Technical Data Sheet", asBool(row.tds_required), asBool(row.tds_dealbreaker)],
  ];
  for (const [key, label, requested, dealbreaker] of stdDocs) {
    if (requested || dealbreaker) {
      items.push({ key, label, kind: "document", requested, dealbreaker, phase, detail: null, askable: true });
    }
  }

  // Sample.
  const sample = row.sample_requirements;
  if (sample && typeof sample === "object") {
    const requested = asBool(sample.is_required);
    const dealbreaker = asBool(sample.is_dealbreaker);
    if (requested || dealbreaker) {
      const size = Number(sample.size_oz) > 0 ? `${sample.size_oz} oz sample` : "sample";
      items.push({ key: "sample", label: "Sample", kind: "sample", requested, dealbreaker, phase, detail: size, askable: true });
    }
  }

  // Custom groups. Certifications come from the child tables; the rest are jsonb
  // columns on this row.
  const groups: Array<[string, string, RequirementKind, { requested: boolean; dealbreaker: boolean; names: string[] }]> = [
    ["certifications", "Certifications", "certification", readCertifications(row)],
    ["custom_statements", "Custom statements", "statement", readGroup(row.custom_statements)],
    ["custom_testing", "Custom testing", "testing", readGroup(row.custom_testing)],
    ["custom_documentation", "Custom documentation", "document", readGroup(row.custom_documentation)],
  ];
  for (const [key, label, kind, g] of groups) {
    if (g.requested || g.dealbreaker) {
      items.push({
        key,
        label: g.names.length ? `${label}: ${g.names.join(", ")}` : label,
        kind,
        requested: g.requested,
        dealbreaker: g.dealbreaker,
        phase,
        detail: g.names.length ? g.names.join(", ") : null,
        askable: true,
      });
    }
  }

  // Minimum shelf life — a spec, not a document to request. Surface only.
  const shelf = row.shelf_life;
  if (shelf && typeof shelf === "object" && Number(shelf.percentage) > 0) {
    items.push({
      key: "shelf_life",
      label: "Minimum shelf life",
      kind: "spec",
      requested: false,
      dealbreaker: asBool(shelf.is_dealbreaker),
      phase,
      detail: `min ${shelf.percentage}%`,
      askable: false,
    });
  }

  return items;
}

interface RequiredCert {
  certification_id: string;
  is_required: boolean;
  is_dealbreaker: boolean;
}

interface RequirementsRow {
  order_type: RequirementPhase;
  coa_required: boolean;
  coa_dealbreaker: boolean;
  sds_required: boolean;
  sds_dealbreaker: boolean;
  tds_required: boolean;
  tds_dealbreaker: boolean;
  sample_requirements: any;
  shelf_life: any;
  custom_statements: any;
  custom_documentation: any;
  custom_testing: any;
  // Null when the org has no certifications row for this order_type.
  cert_documents: any;
  cert_custom_requests: boolean | null;
  required_certs: RequiredCert[] | null;
}

// All qualification requirements for one Tenkara org, across pre- and
// post-order. Returns [] when nothing is configured or the org isn't linked.
//
// One row per order_type, so the LEFT JOINs keep an org that configured
// documents but no certifications. `order by order_type` leans on the
// requirement_order_type enum declaring pre_order first, which preserves the
// pre-then-post item ordering callers already see.
export async function getClientRequirements(orgTenkaraId: string | null | undefined): Promise<RequirementItem[]> {
  if (!orgTenkaraId) return [];
  const rows = await tenkaraQuery<RequirementsRow>(
    `select
       sr.order_type,
       sr.coa_required,
       sr.coa_dealbreaker,
       sr.sds_required,
       sr.sds_dealbreaker,
       sr.tds_required,
       sr.tds_dealbreaker,
       sr.sample_requirements,
       sr.shelf_life,
       sr.custom_statements,
       sr.custom_documentation,
       sr.custom_testing,
       src.documents       as cert_documents,
       src.custom_requests as cert_custom_requests,
       rc.required_certs
     from public.supplier_requirements sr
     left join public.supplier_requirement_certifications src
       on src.requirement_id = sr.id
     left join lateral (
       select jsonb_agg(
                jsonb_build_object(
                  'certification_id', c.certification_id,
                  'is_required',      c.is_required,
                  'is_dealbreaker',   c.is_dealbreaker
                )
                order by c.certification_id
              ) as required_certs
       from public.supplier_requirement_required_certifications c
       where c.requirement_certification_id = src.id
     ) rc on true
     where sr.organization_id = $1::uuid
     order by sr.order_type`,
    [orgTenkaraId]
  );
  return rows.flatMap((row) => parseRequirements(row));
}

// The individual certification names the client marked as a dealbreaker. Their
// names arrive comma-joined in `detail`, so split them back out; a supplier must
// hold ALL of them.
export function dealbreakerCertNames(items: RequirementItem[]): string[] {
  const names = items
    .filter((it) => it.kind === "certification" && it.dealbreaker && it.detail)
    .flatMap((it) => it.detail!.split(",").map((s) => s.trim()).filter(Boolean));
  return Array.from(new Set(names));
}

// The labels a supplier should be asked to provide, deduped across phases.
// Drives the follow-up email ask. Excludes pure specs (e.g. shelf life).
export function requestedDocLabels(items: RequirementItem[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!it.requested || !it.askable) continue;
    const label = it.detail && it.kind === "sample" ? it.detail : it.label;
    const norm = label.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(label);
  }
  return out;
}

// The client's standard-document rules, flattened for a per-quote display. Keyed
// `<phase>:<key>` (e.g. "pre_order:coa"). This is the ONLY source of truth for
// whether a document is required and whether missing it disqualifies the vendor:
// it is a client-level setting held in Tenkara, not something ops decides per
// quote. quote_profiles carries its own preorder_*_required/_dealbreaker columns
// which nothing mirrors into, so they read false for every one of the 939 live
// rows while McGinley's real settings make CoA, SDS and TDS hard dealbreakers.
export interface ClientDocRule {
  required: boolean;
  dealbreaker: boolean;
  detail: string | null;
}

export type ClientDocRules = Record<string, ClientDocRule>;

export function clientDocRules(items: RequirementItem[]): ClientDocRules {
  const rules: ClientDocRules = {};
  for (const it of items) {
    rules[`${it.phase}:${it.key}`] = {
      required: it.requested,
      dealbreaker: it.dealbreaker,
      detail: it.detail,
    };
  }
  return rules;
}
