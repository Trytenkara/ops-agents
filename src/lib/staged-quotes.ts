import type { createAdminClient } from "@/lib/supabase/admin";

// Shared writer for the staged_quotes table (migration 0025). Both the email
// reply-body extractor and the attachment parser funnel through here so the row
// shape and dedup stay consistent. OA-only; Tenkara is never written.

type Admin = ReturnType<typeof createAdminClient>;

export type StagedQuoteSource = "email_body" | "attachment";
export type StagedQuoteConfidence = "high" | "medium" | "low" | "needs_review";

export interface StagedQuoteInput {
  orgId: string | null;
  runId: string | null;
  source: StagedQuoteSource;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  sourceAttachmentName?: string | null;
  sourceAttachmentUrl?: string | null;
  supplierId?: string | null;
  supplierName?: string | null;
  materialId?: string | null;
  materialName?: string | null;
  price: number | null;
  caseSize: number | null;
  unitOfMeasurement: string | null;
  currency?: string | null;
  grade?: string | null;
  confidence?: StagedQuoteConfidence;
  extractionNotes?: string | null;
  rawExtract?: Record<string, any> | null;
}

export interface InsertStagedResult {
  inserted: number;
  skippedDuplicates: number;
  errors: number;
}

// Dedup key within a message: same message + attachment + material + price
// shouldn't be staged twice across re-runs. We check existing rows for the
// message and skip ones that already match.
function dupKey(r: {
  source_message_id: string | null;
  source_attachment_name: string | null;
  material_name: string | null;
  price: number | null;
}): string {
  return [
    r.source_message_id ?? "",
    r.source_attachment_name ?? "",
    (r.material_name ?? "").trim().toLowerCase(),
    r.price ?? "",
  ].join("|");
}

export async function insertStagedQuotes(
  admin: Admin,
  rows: StagedQuoteInput[]
): Promise<InsertStagedResult> {
  const result: InsertStagedResult = { inserted: 0, skippedDuplicates: 0, errors: 0 };
  if (!rows.length) return result;

  // Load existing rows for the message ids we're about to write, to dedup.
  const messageIds = Array.from(
    new Set(rows.map((r) => r.sourceMessageId).filter((x): x is string => !!x))
  );
  const existingKeys = new Set<string>();
  if (messageIds.length) {
    const { data } = await admin
      .from("staged_quotes")
      .select("source_message_id, source_attachment_name, material_name, price")
      .in("source_message_id", messageIds);
    for (const r of (data ?? []) as any[]) existingKeys.add(dupKey(r));
  }

  for (const r of rows) {
    const key = dupKey({
      source_message_id: r.sourceMessageId ?? null,
      source_attachment_name: r.sourceAttachmentName ?? null,
      material_name: r.materialName ?? null,
      price: r.price,
    });
    if (existingKeys.has(key)) {
      result.skippedDuplicates++;
      continue;
    }
    const { error } = await admin.from("staged_quotes").insert({
      org_id: r.orgId,
      run_id: r.runId,
      source: r.source,
      source_conversation_id: r.sourceConversationId ?? null,
      source_message_id: r.sourceMessageId ?? null,
      source_attachment_name: r.sourceAttachmentName ?? null,
      source_attachment_url: r.sourceAttachmentUrl ?? null,
      supplier_id: r.supplierId ?? null,
      supplier_name: r.supplierName ?? null,
      material_id: r.materialId ?? null,
      material_name: r.materialName ?? null,
      price: r.price,
      case_size: r.caseSize,
      unit_of_measurement: r.unitOfMeasurement,
      currency: r.currency ?? "USD",
      grade: r.grade ?? null,
      confidence: r.confidence ?? "needs_review",
      extraction_notes: r.extractionNotes ?? null,
      raw_extract: r.rawExtract ?? {},
      status: "pending_review",
    });
    if (error) {
      result.errors++;
      continue;
    }
    existingKeys.add(key);
    result.inserted++;
  }
  return result;
}
