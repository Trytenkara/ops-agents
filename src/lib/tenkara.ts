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

export const TENKARA_INBOX_BASE = "https://tenkara-inbox-nine.vercel.app";

// Where an operator reviews/sends a Tenkara-staged draft. The agent stages it
// under the client inbox → Pending Outreach; we link to the app (deep-linking to
// a specific conversation can be added once the conversation route is confirmed).
export function tenkaraInboxUrl(_conversationId?: string): string {
  return TENKARA_INBOX_BASE;
}

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

// ---------- Cold outbound (Agents 02 + 04) ----------
//
// Creates a brand-new conversation + draft in one round trip via Tenkara's
// /api/external/conversations. This is the standalone-outbound path for agents
// that start a fresh thread (no conversation_id to reply into). Requires the
// token's `conversations:write` scope. Never sends — operator picks the sender
// and clicks Send in Tenkara's Pending Outreach surface.

// The supplier contact card Tenkara writes to the supplier record on create
// (created if new, updated if the email already exists). `email` is the match
// key; omitted sub-fields take Tenkara's defaults (tz America/New_York, work
// 09:00–17:00, work_days Mon–Fri), so we only send what we actually know.
export interface TenkaraSupplierContact {
  email?: string;                     // match key; defaults to the recipient address
  name?: string | null;
  company?: string | null;
  timezone?: string;                  // IANA, e.g. America/New_York
  work_start?: string;                // "HH:MM"
  work_end?: string;                  // "HH:MM"
  work_days?: number[];               // 0=Sun … 6=Sat
}

export interface CreateTenkaraConversationInput {
  externalId: string;                 // idempotency key, ≤200 chars, stable per intended create
  to: { name?: string | null; address: string };
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  emailAccountId?: string;            // optional sender; omit → operator picks at review
  supplierContact?: TenkaraSupplierContact; // written to the supplier record
  context?: Record<string, any>;      // free-form; forwarded verbatim on the conversation.agent_created webhook
}

export interface TenkaraConversation {
  conversationId: string;
  draftId: string;                    // matches draft_id on later send/discard webhooks
  requiresSenderSelection: boolean;
  createdAt?: string;
  idempotent: boolean;                // true if external_id replayed an existing create
}

export async function createTenkaraConversation(input: CreateTenkaraConversationInput): Promise<TenkaraConversation> {
  const token = process.env.TENKARA_API_TOKEN;
  if (!token) throw new Error("TENKARA_API_TOKEN not configured");
  if (!input.externalId) throw new Error("createTenkaraConversation requires externalId");

  const payload: Record<string, unknown> = {
    external_id: input.externalId,
    to_email: input.to.address,
    subject: input.subject,
    body_html: input.bodyHtml,
  };
  if (input.to.name) payload.to_name = input.to.name;
  if (input.bodyText) payload.body_text = input.bodyText;
  if (input.emailAccountId) payload.email_account_id = input.emailAccountId;
  if (input.supplierContact) {
    const sc = input.supplierContact;
    const contact: Record<string, unknown> = { email: (sc.email ?? input.to.address).toLowerCase() };
    if (sc.name != null) contact.name = sc.name;
    if (sc.company != null) contact.company = sc.company;
    if (sc.timezone) contact.timezone = sc.timezone;
    if (sc.work_start) contact.work_start = sc.work_start;
    if (sc.work_end) contact.work_end = sc.work_end;
    if (sc.work_days) contact.work_days = sc.work_days;
    payload.supplier_contact = contact;
  }
  if (input.context) payload.context = input.context;

  const res = await fetch(`${TENKARA_INBOX_BASE}/api/external/conversations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tenkara POST /api/external/conversations failed: ${res.status} ${text.slice(0, 500)}`);
  }

  const body = await res.json();
  return {
    conversationId: body.conversation_id ?? "",
    draftId: body.draft_id ?? "",
    requiresSenderSelection: body.requires_sender_selection ?? true,
    createdAt: body.created_at,
    idempotent: body.idempotent ?? false,
  };
}

// Per-client Tenkara Inbox account UUIDs (from Rod, 2026-06-18). Conversations
// MUST be created with an email_account_id — a null account makes the thread
// invisible on Tenkara's side (placement is driven by the account label). The
// account is keyed by the EFFECTIVE SENDING BRAND, not the underlying client:
// ghost outreach goes out under the ghostBrand (Bobber Labs / Rove Essentials),
// so it lands in that brand's inbox. Keys are normalized (lowercased, single-
// spaced); aliases cover the differing spellings between organizations.name and
// the Tenkara teamspace label.
const TENKARA_EMAIL_ACCOUNT_IDS: Record<string, string> = {
  "bobber labs": "425a6757-c1a6-4281-88d3-acd3cb851d12",
  "nutripro": "a42625c6-55b7-4dc5-94e8-dca567dca8fc",
  "nutripro group": "a42625c6-55b7-4dc5-94e8-dca567dca8fc",
  "pharmalab": "80a63de7-13c8-489b-98d8-535ccf09efc3",
  "pharmalab enterprises": "80a63de7-13c8-489b-98d8-535ccf09efc3",
  "rove essentials": "d350fc1e-984d-4efd-9332-b20f8d7f66e2",
  "vita organica": "294ba3df-a368-4e5d-8508-099267ca9665",
  "operations": "424f6dc3-8c78-4201-b5e3-69e242e34735",
};

function normalizeBrand(brand: string): string {
  return brand.trim().toLowerCase().replace(/\s+/g, " ");
}

// Resolve an Inbox account UUID from a brand name. Returns undefined for brands
// with no Tenkara teamspace (e.g. McGinley, Sphere, Ulo) — callers should omit
// email_account_id and warn rather than guess a mailbox.
export function resolveTenkaraEmailAccountId(brand: string | null | undefined): string | undefined {
  if (!brand) return undefined;
  return TENKARA_EMAIL_ACCOUNT_IDS[normalizeBrand(brand)];
}

// The mailbox a cold-outbound draft should send from, derived from the same
// (mode, clientOrgName, ghostBrand) the drafter already uses. Ghost outreach
// files under the ghostBrand inbox; active outreach under the client's own.
export function tenkaraEmailAccountIdFor(input: {
  mode: "active" | "ghost";
  clientOrgName?: string | null;
  ghostBrand?: string | null;
}): string | undefined {
  const brand = input.mode === "ghost" ? input.ghostBrand : input.clientOrgName;
  return resolveTenkaraEmailAccountId(brand);
}

// Rollout flag: which email app a cold-outbound agent stages into. Defaults to
// Missive. Set COLD_OUTBOUND_TENKARA_AGENTS to "all" (or a csv like "04" /
// "02,04") to route those agents to Tenkara. Lets us flip per-deploy — and
// migrate one agent at a time — without a code change.
export function coldOutboundEmailClient(agent: "02" | "04"): "missive" | "rod_app" {
  const raw = (process.env.COLD_OUTBOUND_TENKARA_AGENTS ?? "").trim().toLowerCase();
  if (!raw) return "missive";
  if (raw === "all" || raw === "true" || raw === "1") return "rod_app";
  const enabled = new Set(raw.split(",").map((s) => s.trim()));
  return enabled.has(agent) ? "rod_app" : "missive";
}
