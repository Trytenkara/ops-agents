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
  unitPriceGapReason?: string | null;
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

// Suppliers reply on-thread, so their client appends the whole prior exchange.
// Extraction reads that quoted history and re-emits quotes we already captured
// from the message where they first arrived (one $4.53/lb quote became four rows;
// a "sorry, forgot the attachment" email with no new quote duplicated all six of
// a supplier's products). Deduping per-message cannot catch it: the echo carries
// a different message id. So the echo key is scoped to the CONVERSATION.
//
// Deliberately not a blanket "ignore quoted text" rule: some replies arrive as a
// Fwd where the quoted body is the only copy of the price. Keep extracting
// everything, then drop lines identical to what the thread already holds. A
// differing price/basis is new information and still lands as its own row.
function echoKey(r: {
  source_conversation_id: string | null;
  material_name: string | null;
  price: number | null;
  currency: string | null;
  unit_of_measurement: string | null;
  case_size: number | null;
}): string | null {
  if (!r.source_conversation_id) return null;
  // Echoes are rarely byte-identical: suppliers' own product lines pick up
  // "(Product Code 300902)" style suffixes between sends, so compare on the
  // material name with parentheticals and punctuation stripped.
  const material = (r.material_name ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return [
    r.source_conversation_id,
    material,
    r.price ?? "",
    (r.currency ?? "").trim().toUpperCase(),
    (r.unit_of_measurement ?? "").trim().toLowerCase(),
    r.case_size ?? "",
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

  // Everything the thread already holds, so a re-quote of it is recognised as an
  // echo. Dismissed rows are excluded: ops rejecting a line should not stop the
  // supplier re-quoting it later.
  const conversationIds = Array.from(
    new Set(rows.map((r) => r.sourceConversationId).filter((x): x is string => !!x))
  );
  const existingEchoKeys = new Set<string>();
  if (conversationIds.length) {
    const { data } = await admin
      .from("staged_quotes")
      .select("source_conversation_id, material_name, price, currency, unit_of_measurement, case_size")
      .in("source_conversation_id", conversationIds)
      .not("status", "eq", "dismissed");
    for (const r of (data ?? []) as any[]) {
      const k = echoKey(r);
      if (k) existingEchoKeys.add(k);
    }
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

  // Whether we already hold a price from this supplier for this material. A
  // first quote is not a change, so it gets 'none'; anything after it is the
  // supplier stating a new number, which is 'supplier' by definition (the FX
  // pass is the only other writer, and it overwrites this with 'currency').
  const quotedBefore = new Set<string>();
  if (orgIds.length) {
    const { data } = await admin
      .from("staged_quotes")
      .select("org_id, supplier_name, material_name")
      .in("org_id", orgIds)
      .neq("status", "dismissed");
    for (const r of (data ?? []) as any[]) {
      quotedBefore.add(approvedKey(r.org_id, r.supplier_name, r.material_name));
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
    // Structured counterparts of the prose note below. The note stays (operators
    // read it during review), but a delta cannot be computed from a sentence, so
    // the same facts are stored as columns.
    let nativePrice: number | null = null;
    let nativeCurrency: string | null = null;
    let fxRate: number | null = null;
    let fxRateAt: string | null = null;
    if (norm.status === "converted" && r.price != null) {
      price = norm.convert(r.price);
      nativePrice = r.price;
      nativeCurrency = (r.currency ?? "").trim().toUpperCase();
      fxRate = norm.rate;
      fxRateAt = new Date().toISOString();
      extractionNotes = [`${norm.note} (was ${(r.currency ?? "").trim().toUpperCase()} ${r.price}, stored USD ${price}).`, extractionNotes]
        .filter(Boolean)
        .join(" ");
    } else if (norm.status === "usd" && r.price != null) {
      // Stamp USD quotes too, so a null native_currency means "unknown", never
      // "was dollars". Same reason as the marketplace pull: the delta split must
      // not be able to mistake an unrecorded currency for a confirmed one.
      nativePrice = r.price;
      nativeCurrency = "USD";
      fxRate = 1;
      fxRateAt = new Date().toISOString();
    } else if (norm.status === "unconvertible") {
      confidence = "needs_review";
      extractionNotes = [`${norm.note}. Confirm currency/price before approving.`, extractionNotes]
        .filter(Boolean)
        .join(" ");
    }

    // unit_price is generated from price / case_size, so a null case_size is how
    // an unknown price basis reaches the UI as a blank cell. Guarantee the blank
    // always carries a why: the extractor supplies one when it recognises the
    // ambiguity, and this covers the case where it just returned no case_size.
    const gapReason =
      price != null && r.caseSize == null
        ? r.unitPriceGapReason?.trim() ||
          "Supplier did not state what quantity this price covers, so no per-unit price could be derived."
        : null;

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
    const echo = echoKey({
      source_conversation_id: r.sourceConversationId ?? null,
      material_name: r.materialName ?? null,
      price,
      currency,
      unit_of_measurement: r.unitOfMeasurement ?? null,
      case_size: r.caseSize,
    });
    if (echo && existingEchoKeys.has(echo)) {
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
      native_price: nativePrice,
      native_currency: nativeCurrency,
      fx_rate: fxRate,
      fx_rate_at: fxRateAt,
      // Frozen anchor. `price`/`fx_rate` float with the FX refresh; these two
      // stay at what the supplier's quote was worth the day it arrived, which is
      // the only thing the currency delta can be measured against. Null for USD
      // quotes: nothing restates them, so there is no drift to anchor.
      captured_price: nativePrice != null ? price : null,
      captured_fx_rate: fxRate,
      // A quote starts life as something a supplier actually said. The FX pass
      // may later restate `price` and overwrite this with 'fx_refresh', which is
      // the point: it distinguishes a number the supplier stands behind from one
      // we recomputed for them.
      price_source: "supplier_quote",
      price_source_at: new Date().toISOString(),
      price_change_source: quotedBefore.has(approvedKey(r.orgId, r.supplierName ?? null, r.materialName ?? null)) ? "supplier" : "none",
      case_size: r.caseSize,
      unit_price_gap_reason: gapReason,
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
    if (echo) existingEchoKeys.add(echo);
    result.inserted++;
  }
  return result;
}
