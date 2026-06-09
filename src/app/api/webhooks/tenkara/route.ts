import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Inbound webhook from Tenkara (Rod's email app). Fires when an operator
// sends or discards one of our agents' staged drafts so we can flip the
// matching draft_references row out of 'staged'/'reviewed'.
//
// Auth: HMAC-SHA256 over the raw request body, keyed with TENKARA_WEBHOOK_SECRET
// (the signing secret Rod generates per-token). Sent in the X-Tenkara-Signature
// header as either "sha256=<hex>" or the bare hex digest.

const SIGNATURE_HEADER = "x-tenkara-signature";

const statusSchema = z.object({
  event: z.enum(["draft.sent", "draft.discarded"]),
  draft_id: z.string().min(1),       // Tenkara's draft id == draft_references.draft_id
  thread_id: z.string().optional(),
  operator: z.string().optional(),   // free-form operator identifier from Tenkara
  occurred_at: z.string().optional(),
});

const inboundSchema = z.object({
  event: z.literal("message.received"),
  conversation_id: z.string().min(1),
  message_id: z.string().min(1),
  in_reply_to_draft_id: z.string().nullish(),
  from: z.string().min(1),
  subject: z.string().nullish(),
  body_text: z.string().nullish(),
  received_at: z.string().nullish(),
});

// Fired after a cold-outbound conversation+draft is created via Tenkara's
// /api/external/conversations. A resilience confirmation (fires once per real
// create, never on idempotent replay) that lets us record the staged draft even
// if the synchronous 201 was lost. Internal ids (org/supplier/material/lead/
// operator) ride along in `context` so we can populate the draft_references row.
const conversationCreatedSchema = z.object({
  event: z.literal("conversation.agent_created"),
  conversation_id: z.string().min(1),
  draft_id: z.string().min(1),
  external_id: z.string().nullish(),
  agent_name: z.string().nullish(),
  to_email: z.string().nullish(),
  to_name: z.string().nullish(),
  subject: z.string().nullish(),
  requires_sender_selection: z.boolean().nullish(),
  created_at: z.string().nullish(),
  context: z.record(z.any()).nullish(),
});

const EVENT_TO_STATUS: Record<z.infer<typeof statusSchema>["event"], "sent" | "discarded"> = {
  "draft.sent": "sent",
  "draft.discarded": "discarded",
};

function verifySignature(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  // Hex strings of differing length can't match; bail before timingSafeEqual (which throws on length mismatch).
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

export async function POST(request: NextRequest) {
  const secret = process.env.TENKARA_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook_not_configured" }, { status: 503 });
  }

  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get(SIGNATURE_HEADER), secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Inbound supplier reply → match the originating draft, compose + stage a reply.
  if (json?.event === "message.received") {
    const inbound = inboundSchema.safeParse(json);
    if (!inbound.success) {
      return NextResponse.json({ error: inbound.error.flatten() }, { status: 400 });
    }
    const { handleInboundReply } = await import("@/lib/tenkara-inbound");
    const result = await handleInboundReply(admin, inbound.data);
    return NextResponse.json(result.body, { status: result.status });
  }

  // Cold-outbound conversation created via /api/external/conversations →
  // record it as a staged draft (idempotent on draft_id).
  if (json?.event === "conversation.agent_created") {
    const created = conversationCreatedSchema.safeParse(json);
    if (!created.success) {
      return NextResponse.json({ error: created.error.flatten() }, { status: 400 });
    }
    const p = created.data;
    const ctx = (p.context ?? {}) as Record<string, any>;

    const { data: existing } = await admin
      .from("draft_references")
      .select("id")
      .eq("draft_id", p.draft_id)
      .eq("email_client", "rod_app")
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ recorded: false, deduped: true, draft_ref_id: existing.id });
    }

    const { data, error } = await admin
      .from("draft_references")
      .insert({
        email_client: "rod_app",
        thread_id: p.conversation_id,
        draft_id: p.draft_id,
        org_id: ctx.org_id ?? null,
        supplier_id: ctx.supplier_id ?? null,
        material_id: ctx.material_id ?? null,
        quote_id: ctx.quote_id ?? null,
        subject: p.subject ?? null,
        assigned_operator: ctx.assigned_operator ?? null,
        status: "staged",
        metadata: {
          draft_kind: "cold_outbound",
          external_id: p.external_id ?? null,
          agent_name: p.agent_name ?? null,
          to_email: p.to_email ?? null,
          to_name: p.to_name ?? null,
          requires_sender_selection: p.requires_sender_selection ?? null,
          lead_id: ctx.lead_id ?? null,
          context: ctx,
        },
      })
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await admin.from("audit_log").insert({
      action: "draft.cold_outbound_created",
      target_table: "draft_references",
      target_id: data?.id,
      diff: { source: "tenkara_webhook", conversation_id: p.conversation_id, draft_id: p.draft_id, external_id: p.external_id ?? null },
    });

    return NextResponse.json({ recorded: true, draft_ref_id: data?.id });
  }

  // Otherwise it's a draft status event (sent/discarded).
  const parsed = statusSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { event, draft_id, thread_id, operator, occurred_at } = parsed.data;
  const newStatus = EVENT_TO_STATUS[event];
  const reviewedAt = occurred_at ?? new Date().toISOString();

  // Match on Tenkara's draft id within Rod's app namespace.
  let lookup = admin
    .from("draft_references")
    .select("id, status, metadata")
    .eq("draft_id", draft_id)
    .eq("email_client", "rod_app");
  if (thread_id) lookup = lookup.eq("thread_id", thread_id);
  const { data: draft, error: lookupErr } = await lookup.maybeSingle();

  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  if (!draft) return NextResponse.json({ error: "draft_not_found" }, { status: 404 });

  // Idempotent: a redelivered webhook for an already-terminal draft is a no-op.
  if (draft.status === "sent" || draft.status === "discarded") {
    return NextResponse.json({ draft_id: draft.id, status: draft.status, deduped: true });
  }

  const metadata = {
    ...(draft.metadata ?? {}),
    tenkara_webhook: { event, operator: operator ?? null, occurred_at: reviewedAt },
  };

  const { error: updateErr } = await admin
    .from("draft_references")
    .update({ status: newStatus, reviewed_at: reviewedAt, metadata })
    .eq("id", draft.id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  await admin.from("audit_log").insert({
    action: `draft.${newStatus}`,
    target_table: "draft_references",
    target_id: draft.id,
    diff: { source: "tenkara_webhook", event, operator: operator ?? null },
  });

  return NextResponse.json({ draft_id: draft.id, status: newStatus });
}
