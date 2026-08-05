import type { SupabaseClient } from "@supabase/supabase-js";
import { mergedDocFields } from "@/lib/supplier-documents";

// The captured-documents side of a quote. Agent 09 (web) and the inbound email
// webhook both write supplier_documents; this indexes them so a quote row can
// show, and export, the documents that belong to it.
//
// Keyed by supplier + material because that is how the rows actually land: of
// 167 live rows only 5 carry a supplier_id, 163 carry a material_id, and 112 of
// the 115 that match a quote's supplier match its material too. So supplier name
// is the workhorse key and material narrows it.

export interface QuoteDoc {
  id: string;
  doc_type: string;
  file_name: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  material_id: string | null;
  source_url: string | null;
  expires_on: string | null;
  extracted: Record<string, any> | null;
  extracted_overrides: Record<string, any> | null;
  extracted_edited_by: string | null;
  content_sha256: string | null;
  storage_path: string | null;
  source_kind: string | null;
  supplier_issued: boolean | null;
}

export type SupplierDocIndex = Record<string, QuoteDoc[]>;

const DOC_COLUMNS =
  "id, doc_type, file_name, supplier_id, supplier_name, material_id, source_url, expires_on, extracted, extracted_overrides, extracted_edited_by, content_sha256, storage_path, source_kind, supplier_issued";

// The dedupe key that stops the row-level dedupe from being fooled: two pages
// linking the same file produce two rows (dupKey includes source_message_id), and
// the quote card would show the same SDS twice. Identical bytes are the same
// document; without bytes, filename + type is the best we have.
function sameDocKey(d: QuoteDoc): string {
  return d.content_sha256 ?? `${(d.file_name ?? "").trim().toLowerCase()}|${d.doc_type}`;
}

// An empty supplier name must NOT produce the key "name:", or every unattributed
// document (12 live rows: catalogues, an image001.png) would attach to every quote
// whose supplier name is also blank.
const nameKey = (name: string | null | undefined) => {
  const n = (name ?? "").trim().toLowerCase();
  return n ? `name:${n}` : null;
};

function keysFor(d: { supplier_id: string | null; supplier_name: string | null; material_id: string | null }): string[] {
  const owners = [d.supplier_id ? `id:${d.supplier_id}` : null, nameKey(d.supplier_name)].filter(
    (x): x is string => !!x
  );
  // A document with no material is supplier-level (a company certificate), so it
  // belongs to every quote for that supplier.
  return owners.flatMap((o) => (d.material_id ? [`${o}|m:${d.material_id}`] : [o]));
}

export async function loadSupplierDocIndex(admin: SupabaseClient, orgId: string): Promise<SupplierDocIndex> {
  const index: SupplierDocIndex = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("supplier_documents")
      .select(DOC_COLUMNS)
      .eq("org_id", orgId)
      .order("retrieved_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const d of (data ?? []) as QuoteDoc[]) {
      for (const k of keysFor(d)) (index[k] ??= []).push(d);
    }
    if (!data || data.length < PAGE) return index;
  }
}

// Documents for one quote: the material-specific ones, plus the supplier-level
// ones. Deduped, because a row carrying both a supplier_id and a name indexes twice.
export function docsForQuote(
  index: SupplierDocIndex | undefined,
  quote: { supplier_id: string | null; supplier_name: string; material_id: string | null }
): QuoteDoc[] {
  if (!index) return [];
  const owners = [quote.supplier_id ? `id:${quote.supplier_id}` : null, nameKey(quote.supplier_name)].filter(
    (x): x is string => !!x
  );
  const keys = owners.flatMap((o) => (quote.material_id ? [`${o}|m:${quote.material_id}`, o] : [o]));
  const seen = new Set<string>();
  const out: QuoteDoc[] = [];
  for (const k of keys) {
    for (const d of index[k] ?? []) {
      const key = sameDocKey(d);
      if (seen.has(d.id) || seen.has(key)) continue;
      seen.add(d.id);
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

const CSV_TYPE_LABEL: Record<string, string> = {
  coa: "CoA",
  sds: "SDS",
  tds: "TDS",
  certificate: "Certificate",
  statement: "Statement",
  testing: "Testing",
  price_sheet: "Price sheet",
  other: "Document",
};

// "SDS; TDS x2; CoA", what is on file at a glance, for a CSV cell.
export function docsOnFileCell(docs: QuoteDoc[]): string {
  const counts = new Map<string, number>();
  for (const d of docs) counts.set(d.doc_type, (counts.get(d.doc_type) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([t, n]) => `${CSV_TYPE_LABEL[t] ?? t}${n > 1 ? ` x${n}` : ""}`)
    .join("; ");
}

// The facts read off the documents, flattened for a CSV cell. Reads corrections
// on top of the parse (mergedDocFields), same as the UI, so an operator's fix
// is what leaves the building.
export function docFieldsCell(docs: QuoteDoc[]): string {
  const parts: string[] = [];
  for (const d of docs) {
    const f = mergedDocFields(d);
    const bits = Object.entries(f)
      .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "")
      .map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").slice(0, 120)}`);
    if (!bits.length) continue;
    parts.push(`[${CSV_TYPE_LABEL[d.doc_type] ?? d.doc_type}] ${bits.join(", ")}`);
  }
  return parts.join(" | ");
}

// Earliest expiry across the documents, with a marker when it is already past.
export function docExpiryCell(docs: QuoteDoc[]): string {
  const dates = docs.map((d) => d.expires_on).filter((x): x is string => !!x).sort();
  if (!dates.length) return "";
  const earliest = dates[0];
  return earliest < new Date().toISOString().slice(0, 10) ? `${earliest} (EXPIRED)` : earliest;
}

// Absolute because the cell is clicked from a spreadsheet, where a relative path
// has nothing to resolve against. The browser knows its own origin; SSR of this
// client component falls back to the configured one.
function appOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

// Where an operator opens the file. Our own copy wins over the supplier's URL:
// suppliers replace and remove files at the same address (3 TDS links died within
// four days of capture), and the download route mints a signed URL for the private
// bucket. Only rows captured before byte storage fall back to the supplier link.
// Plain URLs, one per document in the same order as docsOnFileCell, so a
// spreadsheet still auto-links them.
export function docUrlsCell(docs: QuoteDoc[]): string {
  const origin = appOrigin();
  return docs
    .map((d) =>
      d.storage_path
        ? `${origin}/api/supplier-documents/${d.id}`
        : /^https?:\/\//i.test(d.source_url ?? "")
          ? d.source_url!
          : "(no stored copy)"
    )
    .filter(Boolean)
    .join("; ");
}
