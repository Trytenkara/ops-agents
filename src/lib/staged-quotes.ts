import type { createAdminClient } from "@/lib/supabase/admin";
import { computeCaseDimensions } from "@/lib/case-dimensions";
import { normalizeToUsd } from "@/lib/fx";

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
  leadTimeDays?: number | null;
  leadTimeText?: string | null;
  moqQuantity?: number | null;
  moqUnit?: string | null;
  paymentTerms?: string | null;
  confidence?: StagedQuoteConfidence;
  extractionNotes?: string | null;
  rawExtract?: Record<string, any> | null;
}

export interface InsertStagedResult {
  inserted: number;
  skippedDuplicates: number;
  errors: number;
}

function approvedKey(orgId: string | null, supplierName: string | null, materialName: string | null): string {
  return [orgId ?? "", (supplierName ?? "").trim().toLowerCase(), (materialName ?? "").trim().toLowerCase()].join("|");
}

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

  // Guard against re-staging quotes for supplier+material combos that are
  // already approved. Without this, a follow-up email or webhook retry creates
  // a new pending_review row that shadows the approved one in the UI.
  const orgIds = Array.from(new Set(rows.map((r) => r.orgId).filter(Boolean))) as string[];
  const approvedSet = new Set<string>();
  if (orgIds.length) {
    const { data } = await admin
      .from("staged_quotes")
      .select("org_id, supplier_name, material_name")
      .in("org_id", orgIds)
      .eq("status", "approved");
    for (const r of (data ?? []) as any[]) {
      approvedSet.add(approvedKey(r.org_id, r.supplier_name, r.material_name));
    }
  }

  for (const r of rows) {
    // Currency safety net, same policy as the marketplace pull: convert a listed
    // foreign price to USD before it is stored (unit_price is a generated column,
    // so it follows price automatically), and when no rate is reachable, keep the
    // number in its listed currency but force needs_review rather than let a raw
    // foreign figure sit in the table as USD. Runs before dedup so the dup key is
    // computed on the value we actually store.
    const norm = await normalizeToUsd(r.currency);
    let price = r.price;
    let currency = norm.currency;
    let confidence: StagedQuoteConfidence = r.confidence ?? "needs_review";
    let extractionNotes = r.extractionNotes ?? null;
    if (norm.status === "converted" && r.price != null) {
      price = norm.convert(r.price);
      extractionNotes = [`${norm.note} (was ${(r.currency ?? "").trim().toUpperCase()} ${r.price}, stored USD ${price}).`, extractionNotes]
        .filter(Boolean)
        .join(" ");
    } else if (norm.status === "unconvertible") {
      price = null;
      confidence = "needs_review";
      extractionNotes = [`${norm.note}. Original extracted value: ${r.currency ?? "unknown currency"} ${r.price ?? "unknown"}. Confirm currency and price before approving.`, extractionNotes]
        .filter(Boolean)
        .join(" ");
    }

    const key = dupKey({
      source_message_id: r.sourceMessageId ?? null,
      source_attachment_name: r.sourceAttachmentName ?? null,
      material_name: r.materialName ?? null,
      price,
    });
    if (existingKeys.has(key)) {
      result.skippedDuplicates++;
      continue;
    }
    if (approvedSet.has(approvedKey(r.orgId, r.supplierName ?? null, r.materialName ?? null))) {
      result.skippedDuplicates++;
      continue;
    }
    // Best-effort: auto-fill outer case dimensions for the freight calc at
    // insert time. Never blocks staging — a failure just leaves the columns null
    // for the case-dimensions backfill (or ops) to fill later.
    const dims = await computeCaseDimensions({
      materialName: r.materialName,
      caseSize: r.caseSize,
      unitOfMeasurement: r.unitOfMeasurement,
      moq: r.moqQuantity != null ? `${r.moqQuantity} ${r.moqUnit ?? ""}`.trim() : null,
      grade: r.grade,
      raw: r.rawExtract,
    });

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
      price,
      case_size: r.caseSize,
      unit_of_measurement: r.unitOfMeasurement,
      currency,
      grade: r.grade ?? null,
      lead_time_days: r.leadTimeDays ?? null,
      lead_time_text: r.leadTimeText ?? null,
      moq_quantity: r.moqQuantity ?? null,
      moq_unit: r.moqUnit ?? null,
      payment_terms: r.paymentTerms ?? null,
      confidence,
      extraction_notes: extractionNotes,
      raw_extract: r.rawExtract ?? {},
      case_type: dims?.case_type ?? null,
      case_dimensions: dims?.case_dimensions ?? null,
      dim_source: dims?.dim_source ?? null,
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
