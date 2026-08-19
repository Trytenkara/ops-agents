import type { createAdminClient } from "@/lib/supabase/admin";
import { computeCaseDimensions } from "@/lib/case-dimensions";
import { normalizeToUsd } from "@/lib/fx";
import { publishablePrice } from "@/lib/price-publish";

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
  incoterm?: string | null;
  incotermLocation?: string | null;
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
  return [
    r.source_conversation_id,
    materialKey(r.material_name),
    r.price ?? "",
    (r.currency ?? "").trim().toUpperCase(),
    (r.unit_of_measurement ?? "").trim().toLowerCase(),
    r.case_size ?? "",
  ].join("|");
}

function materialKey(name: string | null): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A row with no price is not a quote, it is a note that a price exists somewhere
// ("we can drop the price a bit at 8+ drums"). The echo key cannot catch a
// repeat of one, because the two mentions rarely agree on the basis: the same
// Makesy discount arrived once as 3,352 lb and once as 8 drums, so it read as
// two different lines and the supplier appeared three times in review with one
// real price between them.
//
// So a thread holds at most one priceless line per material, and if the thread
// already holds a real price for that material the note goes onto that row
// instead of beside it. Nothing is discarded: the sentence the supplier wrote is
// what ops needs, and it is more use attached to the price it qualifies.
function pricelessKey(conversationId: string | null, materialName: string | null): string | null {
  if (!conversationId) return null;
  return `${conversationId}|${materialKey(materialName)}`;
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
  // What the thread already holds without a price, and what it holds with one:
  // a second priceless mention of the same material is noise, and the first one
  // belongs on the priced row when there is one.
  const pricelessSeen = new Set<string>();
  const pricedRowByKey = new Map<string, { id: string; extraction_notes: string | null }>();
  if (conversationIds.length) {
    const { data } = await admin
      .from("staged_quotes")
      .select("id, source_conversation_id, material_name, price, currency, unit_of_measurement, case_size, extraction_notes, created_at")
      .in("source_conversation_id", conversationIds)
      .not("status", "eq", "dismissed")
      .order("created_at");
    for (const r of (data ?? []) as any[]) {
      const k = echoKey(r);
      if (k) existingEchoKeys.add(k);
      const pk = pricelessKey(r.source_conversation_id, r.material_name);
      if (!pk) continue;
      if (r.price == null) pricelessSeen.add(pk);
      else if (!pricedRowByKey.has(pk)) pricedRowByKey.set(pk, { id: r.id, extraction_notes: r.extraction_notes ?? null });
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

  // Supplier+material combos where an operator has already set the price by
  // hand. A later quote from the supplier is a real new number and still gets
  // its own row, but it must not read as the first word on that price: someone
  // already ruled on this once, and whoever picks the new row up needs to know
  // they are second-guessing a decision, not filling a blank.
  const operatorSet = new Set<string>();
  if (orgIds.length) {
    const { data } = await admin
      .from("staged_quotes")
      .select("org_id, supplier_name, material_name")
      .in("org_id", orgIds)
      .eq("price_source", "operator")
      .neq("status", "dismissed");
    for (const r of (data ?? []) as any[]) {
      operatorSet.add(approvedKey(r.org_id, r.supplier_name, r.material_name));
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
    } else if (norm.status === "unknown" && r.price != null) {
      // No currency anywhere on the quote. The number is kept where an operator
      // can see it and confirm it, but it is not stored as a price, because a
      // stored price is a published price and we would be publishing a guess.
      // Not written to native_price either: that column means "the amount as
      // the supplier stated it, in this currency", and the currency is exactly
      // what we do not have. The figure stays in the note and the raw extract,
      // where an operator reads it, until someone confirms what it is in.
      price = null;
      currency = "";  // stored as null: unknown, not dollars
      confidence = "needs_review";
      extractionNotes = [
        `Supplier stated ${r.price} with no currency. Confirm the currency with the supplier before approving; withheld rather than assumed to be USD.`,
        extractionNotes,
      ]
        .filter(Boolean)
        .join(" ");
    } else if (norm.status === "unconvertible") {
      confidence = "needs_review";
      extractionNotes = [`${norm.note}. Confirm currency/price before approving.`, extractionNotes]
        .filter(Boolean)
        .join(" ");
    }

    // Last gate before the row is stored. The FX branch above handles currency;
    // this catches a number that is unreadable, negative or implausible, and
    // replaces it with a null plus the reason rather than a stored guess.
    {
      const gate = publishablePrice(
        { price, currency, native_currency: nativeCurrency, fx_rate: fxRate },
        { where: "quote capture" }
      );
      if (gate.issues.length) {
        price = gate.row.price ?? null;
        confidence = "needs_review";
        extractionNotes = [
          `Price withheld: ${gate.issues.map((i) => i.reason).join("; ")}. Confirm before approving.`,
          extractionNotes,
        ]
          .filter(Boolean)
          .join(" ");
      }
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
    const priceless = price == null ? pricelessKey(r.sourceConversationId ?? null, r.materialName ?? null) : null;
    if (priceless) {
      if (pricelessSeen.has(priceless)) {
        result.skippedDuplicates++;
        continue;
      }
      const priced = pricedRowByKey.get(priceless);
      const note = (r.extractionNotes ?? "").trim();
      if (priced) {
        if (note && !(priced.extraction_notes ?? "").includes(note)) {
          const merged = [priced.extraction_notes, `Also on this thread: ${note}`].filter(Boolean).join(" ");
          await admin.from("staged_quotes").update({ extraction_notes: merged }).eq("id", priced.id);
          priced.extraction_notes = merged;
        }
        result.skippedDuplicates++;
        continue;
      }
      pricelessSeen.add(priceless);
    }
    if (approvedSet.has(approvedKey(r.orgId, r.supplierName ?? null, r.materialName ?? null))) {
      result.skippedDuplicates++;
      continue;
    }
    if (operatorSet.has(approvedKey(r.orgId, r.supplierName ?? null, r.materialName ?? null))) {
      extractionNotes = [
        "An operator set the price on this supplier and material by hand before. This quote lands beside that one rather than replacing it; check what they decided before approving.",
        extractionNotes,
      ].filter(Boolean).join(" ");
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
      // Named writer, not the intake channel: the column only accepts
      // supplier_quote / fx_refresh / operator, and writing "email_body" here
      // made the whole insert fail its check constraint, so every quote captured
      // from a reply body or an attachment was silently dropped.
      price_source: "supplier_quote",
      price_source_at: new Date().toISOString(),
      price_change_source: quotedBefore.has(approvedKey(r.orgId, r.supplierName ?? null, r.materialName ?? null)) ? "supplier" : "none",
      // At insert the quote has not drifted yet, so the supplier-only price is
      // the price. The FX pass moves `price` away from it and leaves this here.
      supplier_price_usd: price,
      // A quote row IS a supplier price statement, so its arrival is the moment
      // the supplier last priced. Nothing later moves this: the FX pass restates
      // `price` without touching it.
      supplier_price_changed_at: new Date().toISOString(),
      case_size: r.caseSize,
      unit_price_gap_reason: gapReason,
      unit_of_measurement: r.unitOfMeasurement,
      // Empty means the supplier never said. Stored as null so no reader can
      // mistake it for a confirmed USD quote.
      currency: currency || null,
      incoterm: r.incoterm ?? null,
      incoterm_location: r.incotermLocation ?? null,
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
      // Always loud. A swallowed insert here once killed every reply and
      // attachment quote in production for a day and a half without a trace.
      console.error("[staged_quotes insert failed]", {
        supplier: r.supplierName ?? null,
        material: r.materialName ?? null,
        conversation: r.sourceConversationId ?? null,
        error: error.message,
      });
      result.errors++;
      continue;
    }
    existingKeys.add(key);
    if (echo) existingEchoKeys.add(echo);
    result.inserted++;
  }
  return result;
}
