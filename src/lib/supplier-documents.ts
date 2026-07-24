import type { createAdminClient } from "@/lib/supabase/admin";

// Capture of qualification documents a supplier emailed (CoA, SDS, certs, ...).
// Classification is a deterministic filename/content-type heuristic — cheap and
// runs on the live inbound webhook path with no extra LLM call. It errs toward
// 'other' rather than guessing; content-based classification can be a follow-up.
// OA-only writer; Tenkara is never written.

type Admin = ReturnType<typeof createAdminClient>;

export type DocType = "coa" | "sds" | "tds" | "certificate" | "statement" | "testing" | "price_sheet" | "other";

export interface SupplierDocumentInput {
  orgId: string | null;
  supplierId?: string | null;
  supplierName?: string | null;
  materialId?: string | null;
  docType: DocType;
  fileName?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  sourceUrl?: string | null;
}

// Best-effort document type from a filename (+ content type). Callers pass
// pricing=true when the attachment already produced quote lines, which pins it
// to 'price_sheet'. Returns 'other' when nothing matches.
//
// Filenames use underscores, dashes, and CamelCase (CoA_AscorbicAcid,
// SafetyDataSheet, Kosher_Certificate), all of which defeat \b word boundaries.
// So we normalize to two forms: `spaced` (non-alphanumerics → spaces) for
// acronym word-matches, and `collapsed` (everything removed) for phrase matches
// that survive concatenation. Order matters: higher-signal types win first.
export function classifyDocType(
  fileName: string | null | undefined,
  contentType?: string | null,
  pricing = false
): DocType {
  if (pricing) return "price_sheet";
  const spaced = `${fileName ?? ""} ${contentType ?? ""}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const collapsed = spaced.replace(/\s+/g, "");
  const word = (w: string) => new RegExp(`(^| )${w}( |$)`).test(spaced); // isolated acronym
  const has = (s: string) => collapsed.includes(s); // phrase, survives concatenation

  if (word("coa") || has("certificateofanalysis")) return "coa";
  if (word("sds") || word("msds") || has("safetydata")) return "sds";
  if (word("tds") || has("technicaldata") || has("specsheet") || has("specification")) return "tds";
  if (has("certificate") || has("kosher") || has("halal") || has("organic") || word("iso") || word("gmp") || word("coo") || has("certificateoforigin"))
    return "certificate";
  if (has("statement") || has("declaration") || has("allergen") || has("nongmo") || has("prop65") || has("vegan") || word("bse") || word("tse"))
    return "statement";
  if (has("testreport") || has("testing") || has("microbiolog") || has("assay") || has("potency")) return "testing";
  return "other";
}

function dupKey(r: { source_message_id: string | null; file_name: string | null; doc_type: string }): string {
  return [r.source_message_id ?? "", (r.file_name ?? "").trim().toLowerCase(), r.doc_type].join("|");
}

export interface InsertDocsResult {
  inserted: number;
  skippedDuplicates: number;
  errors: number;
}

// Insert captured documents, skipping ones already recorded for the same
// message + filename + type (re-runs of the same inbound shouldn't double-store).
export async function insertSupplierDocuments(admin: Admin, rows: SupplierDocumentInput[]): Promise<InsertDocsResult> {
  const result: InsertDocsResult = { inserted: 0, skippedDuplicates: 0, errors: 0 };
  if (!rows.length) return result;

  const messageIds = Array.from(new Set(rows.map((r) => r.sourceMessageId).filter((x): x is string => !!x)));
  const existing = new Set<string>();
  if (messageIds.length) {
    const { data } = await admin
      .from("supplier_documents")
      .select("source_message_id, file_name, doc_type")
      .in("source_message_id", messageIds);
    for (const r of (data ?? []) as any[]) existing.add(dupKey(r));
  }

  for (const r of rows) {
    const key = dupKey({ source_message_id: r.sourceMessageId ?? null, file_name: r.fileName ?? null, doc_type: r.docType });
    if (existing.has(key)) {
      result.skippedDuplicates++;
      continue;
    }
    const { error } = await admin.from("supplier_documents").insert({
      org_id: r.orgId,
      supplier_id: r.supplierId ?? null,
      supplier_name: r.supplierName ?? null,
      material_id: r.materialId ?? null,
      doc_type: r.docType,
      file_name: r.fileName ?? null,
      content_type: r.contentType ?? null,
      size_bytes: r.sizeBytes ?? null,
      source_conversation_id: r.sourceConversationId ?? null,
      source_message_id: r.sourceMessageId ?? null,
      source_url: r.sourceUrl ?? null,
    });
    if (error) {
      result.errors++;
      continue;
    }
    existing.add(key);
    result.inserted++;
  }
  return result;
}
