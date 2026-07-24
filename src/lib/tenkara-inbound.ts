import type { createAdminClient } from "@/lib/supabase/admin";
import { stageDraft } from "@/lib/draft-staging";
import { composeReply } from "@/agents-runtime/agents/email-scanner/reply-drafter";
import { extractQuotesFromReplyText, type ExtractedQuote } from "@/lib/reply-quote-extract";
import { insertStagedQuotes, type StagedQuoteInput, type StagedQuoteSource } from "@/lib/staged-quotes";
import { getTenkaraMessageAttachments, downloadTenkaraAttachment } from "@/lib/tenkara-attachments";
import { parseAttachmentBytes, deriveExt, isPricingCandidateExt } from "@/agents-runtime/agents/email-scanner/attachment-parser";
import { getTenkaraConversationMessages } from "@/lib/tenkara";
import { postAgentAlert } from "@/lib/slack-alert";

// A "reply" from a mailer-daemon isn't the supplier — it's a delivery failure.
// Detect it so we never draft a reply to the daemon and can restart outreach.
function isBounce(senderAddr: string | null, subject: string | null): boolean {
  const a = (senderAddr ?? "").toLowerCase();
  const s = (subject ?? "").toLowerCase();
  if (/mailer-daemon|postmaster@|maildelivery|mail-daemon/.test(a)) return true;
  if (/undeliverable|delivery status notification|delivery (has )?failed|failure notice|returned mail|address not found|recipient.*(reject|not found)|message could not be delivered|mail delivery failed/.test(s)) return true;
  return false;
}

// Handles a Tenkara `message.received` webhook: a supplier replied on a
// conversation one of our agents originated. We match it back to the
// originating draft_references row, compose a reply (inline), and stage that
// reply as a new Tenkara draft in the same conversation for an operator to send.
//
// This is the webhook-driven equivalent of Agent 08's Missive inbox scan — Rod
// pushes us the inbound instead of us polling, and replies go back into Tenkara
// (email_client='rod_app') rather than Missive.

type Admin = ReturnType<typeof createAdminClient>;

export interface InboundMessage {
  conversation_id: string;
  message_id: string;
  in_reply_to_draft_id?: string | null;
  from: string;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  received_at?: string | null;
}

export interface InboundResult {
  status: number;
  body: Record<string, any>;
}

// "Name <email>" → {name, address}; bare "email" → {address}.
function parseFrom(from: string): { name: string | null; address: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || null, address: m[2].trim() };
  return { name: null, address: from.trim() };
}

export async function handleInboundReply(admin: Admin, msg: InboundMessage): Promise<InboundResult> {
  // 1. Find the originating draft (the one our agent posted that this replies to).
  let ref: any = null;
  if (msg.in_reply_to_draft_id) {
    const { data } = await admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata")
      .eq("draft_id", msg.in_reply_to_draft_id)
      .eq("email_client", "rod_app")
      .maybeSingle();
    ref = data;
  }
  if (!ref) {
    const { data } = await admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata")
      .eq("thread_id", msg.conversation_id)
      .eq("email_client", "rod_app")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    ref = data;
  }
  // Rod pre-filters to conversations our agents touched, so a miss is benign —
  // ack with 200 so it isn't retried.
  if (!ref) return { status: 200, body: { ignored: true, reason: "no_matching_draft" } };

  // 2. Idempotency: if we already drafted a reply for this inbound message, no-op.
  const { data: dupe } = await admin
    .from("draft_references")
    .select("id")
    .eq("email_client", "rod_app")
    .eq("metadata->>in_reply_to_message_id", msg.message_id)
    .maybeSingle();
  if (dupe) return { status: 200, body: { deduped: true, draft_ref_id: dupe.id } };

  const refMeta = (ref.metadata ?? {}) as Record<string, any>;
  const from = parseFrom(msg.from);
  const bounceLeadId = refMeta.lead_id as string | undefined;

  // 2b. Bounce / delivery failure. The inbound is a mailer-daemon, not the
  //     supplier — never draft a reply to it. Retire the bounced draft (so a
  //     requeued lead is treated as fresh first contact), alert ops, and open a
  //     manual-outreach case an operator resolves by entering a working email
  //     (addSupplierEmailToCase requeues the lead to restart outreach).
  if (isBounce(from.address, msg.subject ?? null)) {
    if (refMeta.flow_status === "bounced") return { status: 200, body: { deduped: true, reason: "already_bounced" } };
    const supplierLabel = refMeta.supplier_name ?? ref.supplier_id ?? "a supplier";
    await admin
      .from("draft_references")
      .update({
        status: "superseded",
        metadata: { ...refMeta, flow_status: "bounced", bounced: { at: new Date().toISOString(), from: from.address, needs_new_email: true } },
      })
      .eq("id", ref.id);
    await postAgentAlert(
      `:warning: *Bounce* on outreach to *${supplierLabel}*. The email didn't deliver — add a working email on the case to restart outreach.`
    );
    if (bounceLeadId) {
      const { data: existingCase } = await admin
        .from("cases")
        .select("id")
        .eq("type", "manual_outreach")
        .eq("status", "open")
        .eq("metadata->>lead_id", bounceLeadId)
        .maybeSingle();
      if (!existingCase) {
        await admin.from("cases").insert({
          org_id: ref.org_id,
          type: "manual_outreach",
          status: "open",
          supplier_id: ref.supplier_id,
          material_id: ref.material_id,
          assigned_operator: ref.assigned_operator,
          recommended_action: `Outreach to ${supplierLabel} bounced (${from.address}). Enter a working email to restart outreach.`,
          metadata: {
            source: "tenkara-inbound-bounce",
            lead_id: bounceLeadId,
            supplier_name: refMeta.supplier_name ?? null,
            bounced_from: from.address,
            bounced_at: new Date().toISOString(),
          },
        });
      }
    }
    return { status: 200, body: { bounced: true, draft_ref_id: ref.id } };
  }

  // Advance the pipeline board unless the thread is already further along
  // (mirrors Agent 08's flow_status handling so the /work board is consistent
  // whether a reply arrived via Missive scan or the Tenkara webhook).
  const ADVANCED = ["responded", "price_captured", "finalized", "closed_declined"];
  const flowAt = (s: string) => (ADVANCED.includes(refMeta.flow_status) ? refMeta.flow_status : s);

  // 3. Stamp reply_detected on the originating draft (mirrors Agent 08).
  // Held in a const so the final step-8 update (which also spreads refMeta) can
  // re-apply it — otherwise step 8's stale-refMeta spread clobbers it back to null.
  const replyDetected = {
    detected_at: new Date().toISOString(),
    source: "tenkara_webhook",
    reply_message_id: msg.message_id,
    reply_conversation_id: msg.conversation_id,
    reply_sender_email: from.address,
    reply_sender_name: from.name,
    reply_subject: msg.subject ?? null,
  };
  await admin
    .from("draft_references")
    .update({
      metadata: {
        ...refMeta,
        flow_status: flowAt("reply_received"),
        reply_detected: replyDetected,
      },
    })
    .eq("id", ref.id);

  // 4. Pull lead context for a better reply (supplier/material/contact names).
  const leadId = refMeta.lead_id as string | undefined;
  let leadRow: any = null;
  if (leadId) {
    const { data } = await admin
      .from("leads_in_flight")
      .select("payload, supplier_name, material_name")
      .eq("id", leadId)
      .maybeSingle();
    leadRow = data;
    const newPayload = {
      ...((leadRow?.payload as any) ?? {}),
      supplier_reply: {
        replied_at: msg.received_at ?? new Date().toISOString(),
        reply_message_id: msg.message_id,
        reply_conversation_id: msg.conversation_id,
        source: "tenkara_webhook",
      },
    };
    await admin.from("leads_in_flight").update({ payload: newPayload }).eq("id", leadId);
  }

  // Without an Anthropic key we can still record the reply; just don't auto-draft.
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: 200, body: { reply_detected: true, drafted: false, reason: "no_anthropic_key" } };
  }

  // 4b. Capture supplier pricing into staged_quotes for ops review — from the
  // reply body AND from file attachments (PDF quotes, Excel/CSV price lists,
  // photographed price sheets). Best-effort: extraction must never block the
  // reply draft.
  let quotesStaged = 0;
  // Non-inline files the supplier attached to THIS reply. Surfaced to the reply
  // drafter so it acknowledges them instead of insisting the attachment "didn't
  // come through" and asking the supplier to resend it.
  let receivedAttachments: { name: string; pricingExtracted: boolean }[] = [];
  try {
    // Each captured line tagged with where it came from, so the staged row and
    // the lead headline can tell body text from an attached price sheet.
    const captured: {
      q: ExtractedQuote;
      source: StagedQuoteSource;
      attachmentName: string | null;
      attachmentUrl: string | null;
    }[] = [];

    // Inline: prefer the HTML body — suppliers put price ladders in tables that
    // the flattened text loses. Falls back to plain text.
    for (const q of await extractQuotesFromReplyText(msg.body_html || msg.body_text)) {
      captured.push({ q, source: "email_body", attachmentName: null, attachmentUrl: null });
    }

    // Attachments: real (non-inline) pricing-candidate files on the inbound
    // message. Inline images are signature logos, not price sheets — skip them.
    const attachments = await getTenkaraMessageAttachments(msg.conversation_id, msg.message_id);
    const nonInline = attachments.filter((a) => !a.is_inline);
    receivedAttachments = nonInline.map((a) => ({ name: a.filename ?? "attachment", pricingExtracted: false }));
    for (let i = 0; i < nonInline.length; i++) {
      const att = nonInline[i];
      const ext = deriveExt(att.filename, att.content_type);
      if (!isPricingCandidateExt(ext, att.size_bytes)) continue;
      const buf = await downloadTenkaraAttachment(att);
      if (!buf) continue;
      const qs = await parseAttachmentBytes(buf, att.filename, ext);
      if (qs.length) receivedAttachments[i].pricingExtracted = true;
      for (const q of qs) {
        captured.push({ q, source: "attachment", attachmentName: att.filename, attachmentUrl: att.download_url });
      }
    }

    if (captured.length) {
      const staged: StagedQuoteInput[] = captured.map(({ q, source, attachmentName, attachmentUrl }) => ({
        orgId: ref.org_id,
        runId: null,
        source,
        sourceConversationId: msg.conversation_id,
        sourceMessageId: msg.message_id,
        sourceAttachmentName: attachmentName,
        sourceAttachmentUrl: attachmentUrl,
        supplierId: ref.supplier_id,
        supplierName: q.supplier_name ?? leadRow?.supplier_name ?? null,
        materialId: ref.material_id,
        materialName: q.material_name ?? leadRow?.material_name ?? null,
        price: q.price,
        caseSize: q.case_size,
        unitOfMeasurement: q.unit_of_measurement,
        currency: q.currency,
        grade: q.grade,
        leadTimeDays: q.lead_time_days ?? null,
        leadTimeText: q.lead_time_text ?? null,
        moqQuantity: q.moq_quantity ?? null,
        moqUnit: q.moq_unit ?? null,
        paymentTerms: q.payment_terms ?? null,
        confidence: q.confidence,
        extractionNotes: q.notes,
        rawExtract: q as any,
      }));
      const res = await insertStagedQuotes(admin, staged);
      quotesStaged = res.inserted;

      // Mirror the freshest captured price/grade onto the lead so the Leads tab
      // shows the returned quote, not just a "supplier replied" marker. Lowest
      // per-unit line across body + attachments is the headline; ops refines.
      if (leadId && leadRow) {
        const priced = captured
          .filter((c) => c.q.price != null)
          .map((c) => ({
            price: c.q.price,
            case_size: c.q.case_size,
            unit_price: c.q.price != null && c.q.case_size ? c.q.price / c.q.case_size : c.q.price,
            unit_of_measurement: c.q.unit_of_measurement,
            currency: c.q.currency,
            grade: c.q.grade,
            source: c.source,
          }))
          .sort((a, b) => (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity));
        if (priced.length) {
          const best = priced[0];
          // Re-read so we merge onto the supplier_reply marker written above
          // instead of clobbering it with the stale pre-marker payload.
          const { data: fresh } = await admin
            .from("leads_in_flight")
            .select("payload")
            .eq("id", leadId)
            .maybeSingle();
          const payload = (fresh?.payload as any) ?? (leadRow.payload as any) ?? {};
          payload.supplier_reply = {
            ...(payload.supplier_reply ?? {}),
            captured_price: best.price,
            captured_case_size: best.case_size,
            captured_unit_price: best.unit_price,
            captured_unit_of_measurement: best.unit_of_measurement,
            captured_currency: best.currency ?? "USD",
            captured_grade: best.grade ?? null,
            captured_at: msg.received_at ?? new Date().toISOString(),
            captured_source: best.source === "attachment" ? "reply_attachment" : "reply_extract",
          };
          await admin.from("leads_in_flight").update({ payload }).eq("id", leadId);
        }
      }
    }
  } catch {
    // swallow — reply drafting proceeds regardless
  }

  // 5. Compose the reply. Pull the full thread from Tenkara for context so the
  // reply answers what they actually asked and doesn't repeat earlier messages.
  let orgName = "the client";
  if (ref.org_id) {
    const { data: o } = await admin.from("orgs").select("name").eq("id", ref.org_id).maybeSingle();
    orgName = o?.name ?? "the client";
  }
  const mode = (refMeta.outreach_mode === "ghost" ? "ghost" : "active") as "active" | "ghost";
  let threadContext: string | null = null;
  try {
    const thread = await getTenkaraConversationMessages(msg.conversation_id);
    if (thread.length) {
      threadContext = thread
        .map((m) => `[${m.sent_at ?? "?"}] ${m.from_name || m.from_email || "?"}: ${(m.body_text ?? "").trim().slice(0, 1200)}`)
        .join("\n\n")
        .slice(0, 8000);
    }
  } catch {
    // no context — proceed with just the inbound message
  }
  // Phased outreach: other materials for this supplier held back from the first
  // email (payload.phased_hold). If the supplier is engaged, this reply
  // introduces them and we release the hold; otherwise they stay held.
  let heldLeads: { id: string; material_id: string | null; material_name: string | null; payload: any }[] = [];
  if (ref.supplier_id) {
    const { data: hl } = await admin
      .from("leads_in_flight")
      .select("id, material_id, material_name, payload")
      .eq("org_id", ref.org_id)
      .eq("supplier_id", ref.supplier_id)
      .eq("status", "active");
    heldLeads = ((hl ?? []) as any[]).filter((l) => (l.payload ?? {}).phased_hold);
  }
  const heldMaterialNames = heldLeads.map((l) => l.material_name).filter((n): n is string => !!n && !!n.trim());

  const reply = await composeReply({
    mode,
    clientOrgName: orgName,
    ghostBrand: refMeta.ghost_brand ?? undefined,
    supplierName: leadRow?.supplier_name ?? null,
    supplierContactName: (leadRow?.payload as any)?.supplier_contact_name ?? from.name,
    materialName: leadRow?.material_name ?? null,
    originalSubject: ref.subject,
    theirSubject: msg.subject ?? null,
    theirPreview: msg.body_text ?? null,
    receivedAttachments,
    threadContext,
    heldMaterialNames,
  });

  // Introduce held materials only when the supplier engaged. The reply draft then
  // covers the original material plus the introduced ones, so credit them all.
  const introduceHeld = reply.engaged && heldLeads.length > 0;
  const introducedMaterialIds = introduceHeld ? (heldLeads.map((l) => l.material_id).filter(Boolean) as string[]) : [];
  const replyMaterialIds = Array.from(new Set([ref.material_id, ...introducedMaterialIds].filter(Boolean))) as string[];

  // 6. Resolve Agent 08 for attribution (best-effort).
  const { data: agent08 } = await admin
    .from("agents")
    .select("id")
    .eq("slug", "agent-08-email-scanner")
    .maybeSingle();

  // 7. Stage the reply as a Tenkara draft in the same conversation.
  const staged = await stageDraft({
    admin,
    agentId: agent08?.id ?? null,
    runId: null,
    orgId: ref.org_id,
    supplierId: ref.supplier_id,
    materialId: ref.material_id,
    emailClient: "rod_app",
    conversationId: msg.conversation_id,
    to: from,
    subject: reply.subject,
    body: reply.body,
    assignedOperator: ref.assigned_operator,
    metadata: {
      outreach_mode: mode,
      ghost_brand: refMeta.ghost_brand ?? null,
      supplier_name: leadRow?.supplier_name ?? from.name ?? null,
      material_name: leadRow?.material_name ?? null,
      material_ids: replyMaterialIds,
      introduced_material_ids: introducedMaterialIds,
      draft_kind: introduceHeld ? "inbound_reply_with_followup" : "inbound_reply",
      in_reply_to_draft_ref: ref.id,
      in_reply_to_message_id: msg.message_id,
      reply_to_conversation_id: msg.conversation_id,
      lead_id: leadId ?? null,
    },
  });
  if (!staged.ok) return { status: 502, body: { error: `stage_reply_failed: ${staged.error}` } };

  // Release the introduced materials: they're now part of this live conversation.
  // Clear the hold and promote them. Fires once — the hold is gone, so a later
  // reply won't re-introduce them.
  if (introduceHeld) {
    for (const hl of heldLeads) {
      const { phased_hold, ...restPayload } = (hl.payload ?? {}) as any;
      await admin
        .from("leads_in_flight")
        .update({
          stage: "ready_for_outreach",
          payload: {
            ...restPayload,
            outreach: {
              ...(restPayload.outreach ?? {}),
              email_client: "rod_app",
              conversation_id: msg.conversation_id,
              introduced_via: "reply_followup",
              introduced_at: new Date().toISOString(),
              introduced_in_draft_ref: staged.draftRefId ?? null,
            },
          },
        })
        .eq("id", hl.id);
    }
  }

  // 8. Point the originating draft at the reply we just staged.
  await admin
    .from("draft_references")
    .update({
      metadata: {
        ...refMeta,
        flow_status: flowAt("responded"),
        reply_detected: replyDetected,
        reply_draft: {
          draft_ref_id: staged.draftRefId,
          staged_at: new Date().toISOString(),
          conversation_id: staged.conversationId,
          in_reply_to_message_id: msg.message_id,
        },
      },
    })
    .eq("id", ref.id);

  return { status: 200, body: { drafted: true, draft_ref_id: staged.draftRefId, draft_id: staged.draftId, quotes_staged: quotesStaged, introduced_materials: introducedMaterialIds.length } };
}
