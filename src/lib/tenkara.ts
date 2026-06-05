// Tenkara Inbox API client — creates drafts in Rod's email app. Never sends.
//
// Contract (from Rod, Phase 1):
//   POST https://tenkara-inbox-nine.vercel.app/api/drafts
//   Authorization: Bearer tki_<...>   (scope drafts:write)
//   - conversation_id is REQUIRED: Phase 1 only supports replies to an existing
//     Tenkara conversation. Brand-new outbound threads aren't wired yet.
//   - Omitting email_account_id creates the draft with requires_sender_selection:true
//     and Tenkara blocks Send until an operator picks the sending mailbox. That's
//     intentional — agents shouldn't choose the brand mailbox.
//   - Re-POSTing with the same conversation_id + token upserts one draft slot per
//     agent per conversation (no PATCH needed).
//
// The returned draft.id is the exact UUID that comes back on the
// draft.sent / draft.discarded webhook (see /api/webhooks/tenkara).

const TENKARA_INBOX_BASE = "https://tenkara-inbox-nine.vercel.app";

export interface CreateTenkaraDraftInput {
  conversationId: string;             // REQUIRED — Tenkara conversation UUID to reply into
  to: { name?: string | null; address: string };
  subject: string;
  bodyHtml: string;
  bodyText?: string;                  // optional; Tenkara strips HTML if omitted
  cc?: string;                        // RFC5322 address string(s)
  bcc?: string;
  emailAccountId?: string;            // optional; omit → operator picks sender at review
}

export interface TenkaraDraft {
  id: string;                         // draft UUID — matches the status webhook's draft_id
  conversationId: string;             // == our draft_references.thread_id
  emailAccountId: string | null;
  subject?: string;
  requiresSenderSelection: boolean;   // true when emailAccountId was omitted
  createdAt?: string;
}

// Tenkara expects to/cc/bcc as RFC5322 strings: `Name <email>` or bare `email`.
function formatAddress(r: { name?: string | null; address: string }): string {
  return r.name ? `${r.name} <${r.address}>` : r.address;
}

export async function createTenkaraDraft(input: CreateTenkaraDraftInput): Promise<TenkaraDraft> {
  const token = process.env.TENKARA_API_TOKEN;
  if (!token) throw new Error("TENKARA_API_TOKEN not configured");
  if (!input.conversationId) {
    throw new Error("createTenkaraDraft requires conversationId (Phase 1 supports replies only)");
  }

  const payload: Record<string, unknown> = {
    conversation_id: input.conversationId,
    to_addresses: formatAddress(input.to),
    subject: input.subject,
    body_html: input.bodyHtml,
    source: "agent",
  };
  if (input.cc) payload.cc_addresses = input.cc;
  if (input.bcc) payload.bcc_addresses = input.bcc;
  if (input.bodyText) payload.body_text = input.bodyText;
  if (input.emailAccountId) payload.email_account_id = input.emailAccountId;

  const res = await fetch(`${TENKARA_INBOX_BASE}/api/drafts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tenkara POST /api/drafts failed: ${res.status} ${text.slice(0, 500)}`);
  }

  const body = await res.json();
  const d = body.draft ?? body;
  return {
    id: d.id ?? "",
    conversationId: d.conversation_id ?? input.conversationId,
    emailAccountId: d.email_account_id ?? null,
    subject: d.subject,
    requiresSenderSelection: d.requires_sender_selection ?? !input.emailAccountId,
    createdAt: d.created_at,
  };
}
