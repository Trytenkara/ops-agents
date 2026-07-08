import type { createAdminClient } from "@/lib/supabase/admin";
import { stageDraft } from "@/lib/draft-staging";
import { composeReply } from "@/agents-runtime/agents/email-scanner/reply-drafter";
import { extractQuotesFromReplyText } from "@/lib/reply-quote-extract";
import { insertStagedQuotes, type StagedQuoteInput } from "@/lib/staged-quotes";
import { getTenkaraConversationMessages } from "@/lib/tenkara";

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

  // Advance the pipeline board unless the thread is already further along
  // (mirrors Agent 08's flow_status handling so the /work board is consistent
  // whether a reply arrived via Missive scan or the Tenkara webhook).
  const ADVANCED = ["responded", "price_captured", "finalized", "closed_declined"];
  const flowAt = (s: string) => (ADVANCED.includes(refMeta.flow_status) ? refMeta.flow_status : s);

  // 3. Stamp reply_detected on the originating draft (mirrors Agent 08).
  await admin
    .from("draft_references")
    .update({
      metadata: {
        ...refMeta,
        flow_status: flowAt("reply_received"),
        reply_detected: {
          detected_at: new Date().toISOString(),
          source: "tenkara_webhook",
          reply_message_id: msg.message_id,
          reply_conversation_id: msg.conversation_id,
          reply_sender_email: from.address,
          reply_sender_name: from.name,
          reply_subject: msg.subject ?? null,
        },
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

  // 4b. Capture any pricing the supplier stated inline in the reply text into
  // staged_quotes for ops review (the webhook only carries body text — attached
  // price sheets need attachments in the payload, which Tenkara doesn't send).
  // Best-effort: extraction failure must never block the reply draft.
  let quotesStaged = 0;
  try {
    // Prefer the HTML body — suppliers put price ladders in tables that the
    // flattened text loses. Falls back to plain text.
    const quotes = await extractQuotesFromReplyText(msg.body_html || msg.body_text);
    if (quotes.length) {
      const staged: StagedQuoteInput[] = quotes.map((q) => ({
        orgId: ref.org_id,
        runId: null,
        source: "email_body",
        sourceConversationId: msg.conversation_id,
        sourceMessageId: msg.message_id,
        supplierId: ref.supplier_id,
        supplierName: q.supplier_name ?? leadRow?.supplier_name ?? null,
        materialId: ref.material_id,
        materialName: q.material_name ?? leadRow?.material_name ?? null,
        price: q.price,
        caseSize: q.case_size,
        unitOfMeasurement: q.unit_of_measurement,
        currency: q.currency,
        confidence: q.confidence,
        extractionNotes: q.notes,
        rawExtract: q as any,
      }));
      const res = await insertStagedQuotes(admin, staged);
      quotesStaged = res.inserted;
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
    threadContext,
  });

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
      draft_kind: "inbound_reply",
      in_reply_to_draft_ref: ref.id,
      in_reply_to_message_id: msg.message_id,
      reply_to_conversation_id: msg.conversation_id,
      lead_id: leadId ?? null,
    },
  });
  if (!staged.ok) return { status: 502, body: { error: `stage_reply_failed: ${staged.error}` } };

  // 8. Point the originating draft at the reply we just staged.
  await admin
    .from("draft_references")
    .update({
      metadata: {
        ...refMeta,
        flow_status: flowAt("responded"),
        reply_draft: {
          draft_ref_id: staged.draftRefId,
          staged_at: new Date().toISOString(),
          conversation_id: staged.conversationId,
          in_reply_to_message_id: msg.message_id,
        },
      },
    })
    .eq("id", ref.id);

  return { status: 200, body: { drafted: true, draft_ref_id: staged.draftRefId, draft_id: staged.draftId, quotes_staged: quotesStaged } };
}
