// Build a per-supplier CSV from leads_in_flight rows.
// The spec column list pulls from leads_in_flight columns + payload jsonb.
// Anything we don't have stays blank — permissive on purpose, since the
// upstream Lead Creator (Agent 03) will fill payload shape later.

export interface LeadRow {
  id: string;
  org_id: string | null;
  supplier_name: string | null;
  supplier_id: string | null;
  material_name: string | null;
  material_id: string | null;
  stage: string;
  status: string;
  source: string | null;
  payload: Record<string, any> | null;
  agent_run_id: string | null;
  drop_reason: string | null;
  confidence_score: number | null;
  created_at: string;
}

const COLUMNS = [
  "supplier_name",
  "supplier_website",
  "supplier_country",
  "supplier_contact_name",
  "supplier_contact_email",
  "supplier_contact_phone",
  "material_name",
  "inci_name",
  "grade",
  "cas_number",
  "tradename",
  "price",
  "currency",
  "lead_time",
  "moq",
  "validity_until",
  "source",
  "originating_org_id",
  "originating_agent_run_id",
  "enrichment_stage",
  "drop_reason",
  "confidence_score",
  "generated_at",
] as const;

function pick(row: LeadRow, key: string): string {
  // Direct columns first, then payload, then blank.
  const direct: Record<string, string | null | undefined> = {
    supplier_name: row.supplier_name,
    material_name: row.material_name,
    source: row.source,
    originating_org_id: row.org_id,
    originating_agent_run_id: row.agent_run_id,
    enrichment_stage: row.stage,
    drop_reason: row.drop_reason,
    confidence_score: row.confidence_score?.toString(),
    generated_at: new Date().toISOString(),
  };
  if (key in direct) return direct[key] ?? "";
  return row.payload?.[key]?.toString() ?? "";
}

function csvEscape(v: string): string {
  if (v == null) return "";
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function buildSupplierCsv(rows: LeadRow[]): string {
  const header = COLUMNS.join(",");
  const body = rows.map((r) => COLUMNS.map((c) => csvEscape(pick(r, c))).join(",")).join("\n");
  return `${header}\n${body}\n`;
}

export function normalizeSupplierKey(name: string | null): string {
  return (name ?? "").trim().toLowerCase();
}
