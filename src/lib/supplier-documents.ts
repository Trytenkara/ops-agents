import crypto from "crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { uploadBinaryFile } from "@/lib/storage";

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
  extracted?: Record<string, any> | null;
  expiresOn?: string | null; // YYYY-MM-DD
  // The file itself. When present the bytes are stored in the private
  // 'supplier-docs' bucket and hashed, which is what makes a received document
  // evidence rather than a link that may 404 or be quietly revised later.
  bytes?: Buffer | null;
  sourceKind?: "email" | "web";
  // False for a third-party reference copy (a substance SDS from a chemical
  // database). Those are useful chemistry but do not qualify the supplier.
  supplierIssued?: boolean | null;
}

export const DOC_BUCKET = "supplier-docs";

// Content-addressed path, so re-storing identical bytes overwrites itself and
// two suppliers shipping the same manufacturer SDS don't collide.
export function storagePathFor(orgId: string | null, sha: string, fileName: string | null | undefined): string {
  const safe = (fileName ?? "document")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(-80) || "document";
  return `${orgId ?? "unassigned"}/${sha.slice(0, 16)}-${safe}`;
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
  // Rows that already existed but held no file, now given their bytes.
  healed: number;
  errors: number;
}

// Store the file before the row, so a row never claims a storage_path that
// isn't there. An upload failure degrades to the old behaviour (metadata +
// source URL only) rather than losing the document record entirely.
async function storeBytes(r: SupplierDocumentInput): Promise<{ storagePath: string | null; sha: string | null }> {
  if (!r.bytes?.byteLength) return { storagePath: null, sha: null };
  const sha = crypto.createHash("sha256").update(r.bytes).digest("hex");
  const path = storagePathFor(r.orgId, sha, r.fileName);
  try {
    await uploadBinaryFile({
      bucket: DOC_BUCKET,
      path,
      content: r.bytes,
      contentType: r.contentType || "application/octet-stream",
    });
    return { storagePath: path, sha };
  } catch {
    return { storagePath: null, sha: null };
  }
}

// Insert captured documents, skipping ones already recorded for the same
// message + filename + type (re-runs of the same inbound shouldn't double-store).
export async function insertSupplierDocuments(admin: Admin, rows: SupplierDocumentInput[]): Promise<InsertDocsResult> {
  const result: InsertDocsResult = { inserted: 0, skippedDuplicates: 0, healed: 0, errors: 0 };
  if (!rows.length) return result;

  const messageIds = Array.from(new Set(rows.map((r) => r.sourceMessageId).filter((x): x is string => !!x)));
  const existing = new Map<string, { id: string; storage_path: string | null }>();
  if (messageIds.length) {
    const { data } = await admin
      .from("supplier_documents")
      .select("id, source_message_id, file_name, doc_type, storage_path")
      .in("source_message_id", messageIds);
    for (const r of (data ?? []) as any[]) existing.set(dupKey(r), { id: r.id, storage_path: r.storage_path });
  }

  for (const r of rows) {
    const key = dupKey({ source_message_id: r.sourceMessageId ?? null, file_name: r.fileName ?? null, doc_type: r.docType });
    const prior = existing.get(key);
    if (prior) {
      // Every row written before migration 0078 recorded a link and no file. The
      // dedupe was correctly refusing to duplicate them, which also meant a
      // rescan could never give them their bytes. Attach instead of skipping,
      // so the backlog heals itself as pages come round again.
      if (prior.storage_path || !r.bytes?.byteLength) {
        result.skippedDuplicates++;
        continue;
      }
      const { storagePath, sha } = await storeBytes(r);
      if (!storagePath) {
        result.skippedDuplicates++;
        continue;
      }
      const { error } = await admin
        .from("supplier_documents")
        .update({
          storage_path: storagePath,
          content_sha256: sha,
          retrieved_at: new Date().toISOString(),
          source_kind: r.sourceKind ?? "email",
          supplier_issued: r.supplierIssued ?? null,
        })
        .eq("id", prior.id);
      if (error) {
        result.errors++;
        continue;
      }
      existing.set(key, { id: prior.id, storage_path: storagePath });
      result.healed++;
      continue;
    }

    const { storagePath, sha } = await storeBytes(r);

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
      extracted: r.extracted ?? {},
      expires_on: r.expiresOn ?? null,
      storage_path: storagePath,
      content_sha256: sha,
      retrieved_at: new Date().toISOString(),
      source_kind: r.sourceKind ?? "email",
      supplier_issued: r.supplierIssued ?? null,
    });
    if (error) {
      result.errors++;
      continue;
    }
    existing.set(key, { id: "", storage_path: storagePath });
    result.inserted++;
  }
  return result;
}
