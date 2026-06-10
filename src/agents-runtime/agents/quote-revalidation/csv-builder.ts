import { gradeToString } from "./drafter";
import type { OverdueRow } from "./sql";

// 17 columns exactly, in this order — matches the original Python implementation.
const CSV_HEADERS = [
  "Client Org",
  "Outreach Mode",
  "Suggested From Email",
  "Suggested Signoff",
  "Supplier",
  "Supplier Contact Name",
  "Supplier Contact Email",
  "Material",
  "Grade",
  "Last Quote Date",
  "Expired On",
  "Days Overdue",
  "Prev Price USD",
  "Prev Lead Time Days",
  "Created By Operator",
  "Last Updated By Operator",
  "Draft Status",
  "Missive Draft Link",
] as const;

export interface GroupResult {
  group: {
    client_org_id: string;
    client_org_name: string;
    client_purchasing_email: string | null;
    supplier_id: string;
    supplier_name: string;
    supplier_contact_name: string | null;
    supplier_contact_email: string;
    rows: OverdueRow[];
  };
  mode: "active" | "ghost";
  ghostBrand?: string;
  stage: "ok" | "llm_error" | "missive_error" | "tenkara_error";
  error?: string;
  subject?: string;
  body?: string;
  missiveConversationId?: string;
  missiveDraftId?: string;
  // Pre-computed operator deep-link to the staged draft (Missive URL, or null
  // for Tenkara where the conversation surfaces in the Pending Outreach UI).
  draftLink?: string | null;
}

function operatorString(row: OverdueRow): string {
  const fn = (row.author_firstname ?? "").trim();
  const ln = (row.author_lastname ?? "").trim();
  const email = (row.author_email ?? "").trim();
  if (!fn && !ln && !email) return "Unknown";
  const name = `${fn} ${ln}`.trim() || "(no name)";
  return email ? `${name} <${email}>` : name;
}

function csvEscape(value: any): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(results: GroupResult[]): string {
  const today = new Date();
  const rows: string[] = [CSV_HEADERS.join(",")];

  for (const res of results) {
    const { group, mode, ghostBrand, stage } = res;
    const signoff = mode === "active"
      ? `${group.client_org_name} Purchasing Team`
      : `${ghostBrand} Sourcing`;
    const suggestedFrom = group.client_purchasing_email ?? "";

    const draftLink = res.draftLink !== undefined
      ? (res.draftLink ?? "")
      : (stage === "ok" && res.missiveConversationId)
        ? `https://mail.missiveapp.com/#inbox/conversations/${res.missiveConversationId}`
        : "";

    for (const row of group.rows) {
      let draftStatus: string;
      if (stage !== "ok") {
        draftStatus = `Failed: ${res.error ?? stage}`;
      } else if (!row.author_is_active_operator) {
        draftStatus = "Operator Invalid";
      } else {
        draftStatus = "Staged";
      }

      const operator = operatorString(row);
      const expiredOn = row.reanalyze;
      const daysOverdue = expiredOn
        ? Math.floor((today.getTime() - new Date(expiredOn).getTime()) / 86400000)
        : "";

      const cells: any[] = [
        group.client_org_name,
        mode,
        suggestedFrom,
        signoff,
        group.supplier_name,
        group.supplier_contact_name ?? "",
        group.supplier_contact_email,
        row.material_name,
        gradeToString(row.grade),
        row.quote_date ?? "",
        expiredOn ?? "",
        daysOverdue,
        row.price != null ? row.price.toFixed(2) : "",
        row.lead_time_days ?? "",
        operator,
        operator, // Created By Operator + Last Updated By Operator (Tenkara schema has one column)
        draftStatus,
        draftLink,
      ];
      rows.push(cells.map(csvEscape).join(","));
    }
  }

  return rows.join("\n") + "\n";
}
