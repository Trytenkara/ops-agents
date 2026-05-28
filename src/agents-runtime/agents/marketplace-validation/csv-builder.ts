export interface ValidationRow {
  lead_id: string;
  supplier_id: string;
  supplier_name: string | null;
  material_name: string | null;
  inci: string | null;
  still_listed: boolean;
  previous_still_listed: boolean | null;
  state_changed: boolean;
  last_checked_at: string;
}

const HEADERS = [
  "Lead ID",
  "Supplier",
  "Supplier ID",
  "Material",
  "INCI",
  "Still Listed",
  "Drift Signal",
  "State Changed",
  "Previous State",
  "Last Checked",
] as const;

function csvEscape(value: any): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(rows: ValidationRow[]): string {
  const out: string[] = [HEADERS.join(",")];
  for (const r of rows) {
    out.push(
      [
        r.lead_id,
        r.supplier_name ?? "",
        r.supplier_id,
        r.material_name ?? "",
        r.inci ?? "",
        r.still_listed ? "yes" : "no",
        r.still_listed ? "" : "no_longer_listed",
        r.state_changed ? "yes" : "no",
        r.previous_still_listed === null ? "" : r.previous_still_listed ? "yes" : "no",
        r.last_checked_at,
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return out.join("\n") + "\n";
}
