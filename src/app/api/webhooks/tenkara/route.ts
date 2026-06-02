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

const payloadSchema = z.object({
  event: z.enum(["draft.sent", "draft.discarded"]),
  draft_id: z.string().min(1),       // Tenkara's draft id == draft_references.draft_id
  thread_id: z.string().optional(),
  operator: z.string().optional(),   // free-form operator identifier from Tenkara
  occurred_at: z.string().optional(),
});

const EVENT_TO_STATUS: Record<z.infer<typeof payloadSchema>["event"], "sent" | "discarded"> = {
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

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { event, draft_id, thread_id, operator, occurred_at } = parsed.data;
  const newStatus = EVENT_TO_STATUS[event];
  const reviewedAt = occurred_at ?? new Date().toISOString();

  const admin = createAdminClient();

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
