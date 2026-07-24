import { tenkaraQuery } from "./tenkara-readonly";

// Per-client vendor-qualification requirements, configured by the client in
// Tenkara (Client Settings → Sourcing Rules) and stored read-only in
// public.user_supplier_settings as two jsonb blobs: pre_order_requirements and
// post_order_requirements. We read them to (a) ask suppliers for the requested
// documents in the reply follow-up chain, and (b) surface the qualification
// checklist on the Platform Extraction tab ("The bench").
//
// Two jsonb shapes exist in the wild (an older nested `document_flags` variant
// and the current flat variant); readGroup() checks both locations so either
// parses. Read-only; Tenkara is never written.

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

// A custom group ("certifications", "custom_statements", ...) can live either at
// the top level (flat shape) or under document_flags (nested shape). Merge both.
function readGroup(req: any, key: string): { requested: boolean; dealbreaker: boolean; names: string[] } {
  const top = req?.[key] ?? {};
  const nested = req?.document_flags?.[key] ?? {};
  const docs: any[] = Array.isArray(top?.documents) ? top.documents : [];
  const certs: any[] = Array.isArray(top?.required_certifications) ? top.required_certifications : [];
  const names = [...docs, ...certs]
    .map((d) => (typeof d === "string" ? d : d?.name ?? d?.label ?? null))
    .filter((n): n is string => !!n && n.trim().length > 0);
  const requested = asBool(top?.custom_requests) || asBool(nested?.custom_requests) || names.length > 0;
  const dealbreaker = asBool(top?.is_dealbreaker) || asBool(nested?.is_dealbreaker);
  return { requested, dealbreaker, names };
}

// Normalize one requirements blob (pre or post) into a flat item list.
function parseRequirements(req: any, phase: RequirementPhase): RequirementItem[] {
  if (!req || typeof req !== "object") return [];
  const items: RequirementItem[] = [];

  // Standard documents. `*_dealbreaker` only exists in the flat shape.
  const stdDocs: Array<[string, string, string]> = [
    ["coa", "Certificate of Analysis", "coa"],
    ["sds", "Safety Data Sheet", "sds"],
    ["tds", "Technical Data Sheet", "tds"],
  ];
  for (const [key, label, prefix] of stdDocs) {
    const requested = asBool(req[`${prefix}_required`]);
    const dealbreaker = asBool(req[`${prefix}_dealbreaker`]);
    if (requested || dealbreaker) {
      items.push({ key, label, kind: "document", requested, dealbreaker, phase, detail: null, askable: true });
    }
  }

  // Sample.
  const sample = req.sample_requirements;
  if (sample && typeof sample === "object") {
    const requested = asBool(sample.is_required);
    const dealbreaker = asBool(sample.is_dealbreaker);
    if (requested || dealbreaker) {
      const size = Number(sample.size_oz) > 0 ? `${sample.size_oz} oz sample` : "sample";
      items.push({ key: "sample", label: "Sample", kind: "sample", requested, dealbreaker, phase, detail: size, askable: true });
    }
  }

  // Custom groups.
  const groups: Array<[string, string, RequirementKind]> = [
    ["certifications", "Certifications", "certification"],
    ["custom_statements", "Custom statements", "statement"],
    ["custom_testing", "Custom testing", "testing"],
    ["custom_documentation", "Custom documentation", "document"],
  ];
  for (const [key, label, kind] of groups) {
    const g = readGroup(req, key);
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
  const shelf = req.shelf_life;
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

interface RequirementsRow {
  pre_order_requirements: any;
  post_order_requirements: any;
}

// All qualification requirements for one Tenkara org, across pre- and
// post-order. Returns [] when nothing is configured or the org isn't linked.
export async function getClientRequirements(orgTenkaraId: string | null | undefined): Promise<RequirementItem[]> {
  if (!orgTenkaraId) return [];
  const rows = await tenkaraQuery<RequirementsRow>(
    `select pre_order_requirements, post_order_requirements
       from public.user_supplier_settings
      where organization_id = $1::uuid
      limit 1`,
    [orgTenkaraId]
  );
  const row = rows[0];
  if (!row) return [];
  return [...parseRequirements(row.pre_order_requirements, "pre_order"), ...parseRequirements(row.post_order_requirements, "post_order")];
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
