// Re-capture supplier quotes from replies that arrived while quote capture was
// failing its check constraint (2026-08-18 09:16 UTC to 2026-08-19 20:30 UTC).
//
// Inbound bodies are not stored on our side, so each affected thread is re-read
// from Tenkara and re-extracted. insertStagedQuotes does the deduping, so this
// is safe to run more than once and cannot double-stage a quote we already hold.
//
// Usage: tsx scripts/recover-missed-quotes.mts [--apply] [--since ISO]
import { createAdminClient } from "../src/lib/supabase/admin";
import { getTenkaraConversationMessages } from "../src/lib/tenkara";
import { extractQuotesFromReplyText } from "../src/lib/reply-quote-extract";
import { insertStagedQuotes, type StagedQuoteInput } from "../src/lib/staged-quotes";

const apply = process.argv.includes("--apply");
const sinceArg = process.argv.indexOf("--since");
const SINCE = sinceArg > -1 ? process.argv[sinceArg + 1] : "2026-08-18T09:16:00.000Z";

async function main() {
  const admin = createAdminClient();
  const refs: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, thread_id, metadata, updated_at")
      .gte("updated_at", SINCE)
      .order("updated_at")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    refs.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }

  // One thread can carry several refs; the extraction is per conversation.
  const byConversation = new Map<string, any>();
  for (const r of refs) {
    const m = r.metadata ?? {};
    // How a reply is stamped on the reference, in Tenkara's vocabulary.
    if (!["responded", "reply_received", "closed_declined"].includes(m.flow_status)) continue;
    const conv = r.thread_id ?? null; // Tenkara conversation uuid; metadata.external_id is ours, not theirs
    if (!conv || byConversation.has(conv)) continue;
    byConversation.set(conv, r);
  }
  console.log(`refs touched since ${SINCE}: ${refs.length}, replied threads to re-read: ${byConversation.size}`);

  let read = 0, withQuotes = 0, staged = 0, skipped = 0, failed = 0;
  for (const [conv, ref] of byConversation) {
    let messages;
    try {
      messages = await getTenkaraConversationMessages(conv);
    } catch (e: any) {
      failed++;
      console.warn(`  thread ${conv}: could not be read (${e.message})`);
      continue;
    }
    const inbound = messages.filter((m) => m.is_outbound === false && (m.sent_at ?? "") >= SINCE);
    if (!inbound.length) continue;
    read++;
    const { data: lead } = await admin
      .from("leads_in_flight")
      .select("supplier_name, material_name")
      .eq("id", (ref.metadata?.lead_id as string) ?? "00000000-0000-0000-0000-000000000000")
      .maybeSingle();

    for (const msg of inbound) {
      const extraction = await extractQuotesFromReplyText(msg.body_html || msg.body_text);
      if (!extraction.quotes.length) continue;
      withQuotes++;
      const rows: StagedQuoteInput[] = extraction.quotes.map((q: any) => ({
        orgId: ref.org_id,
        runId: null,
        source: "email_body",
        sourceConversationId: conv,
        sourceMessageId: msg.id,
        supplierId: ref.supplier_id ?? null,
        supplierName: q.supplier_name ?? lead?.supplier_name ?? (ref.metadata?.supplier_name as string) ?? null,
        materialId: ref.material_id ?? null,
        materialName: q.material_name ?? lead?.material_name ?? null,
        price: q.price,
        caseSize: q.case_size,
        unitPriceGapReason: q.unit_price_gap_reason ?? null,
        unitOfMeasurement: q.unit_of_measurement,
        currency: q.currency,
        incoterm: q.incoterm ?? null,
        incotermLocation: q.incoterm_location ?? null,
        grade: q.grade,
        leadTimeDays: q.lead_time_days ?? null,
        leadTimeText: q.lead_time_text ?? null,
        moqQuantity: q.moq_quantity ?? null,
        moqUnit: q.moq_unit ?? null,
        paymentTerms: q.payment_terms ?? null,
        confidence: q.confidence,
        extractionNotes: q.notes,
        rawExtract: q,
      }));
      if (!apply) {
        console.log(`  would stage ${rows.length} from ${rows[0].supplierName}: ${rows.map((r) => `${r.materialName} ${r.price ?? "no price"}`).join(", ")}`);
        continue;
      }
      const res = await insertStagedQuotes(admin, rows);
      staged += res.inserted;
      skipped += res.skippedDuplicates;
      if (res.errors) console.warn(`  ${res.errors} row(s) failed to insert on thread ${conv}`);
    }
  }
  console.log(
    `threads re-read: ${read}, messages carrying a quote: ${withQuotes}, ` +
      (apply ? `staged: ${staged}, already held: ${skipped}` : "dry run, nothing written") +
      (failed ? `, unreadable threads: ${failed}` : "")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
