// Missive API client — staging drafts only. Never sends.
//
// Safety invariants enforced at compile time:
//   - `send: true` is rejected by TypeScript (the type below excludes it)
//   - `from_field` is rejected by TypeScript (excluded from CreateDraftInput)
//   - At runtime we also assert these aren't snuck in via `Object.assign` etc.
//
// Reference: https://learn.missiveapp.com/api-documentation/drafts

const MISSIVE_BASE = "https://public.missiveapp.com/v1";

export interface MissiveRecipient {
  name?: string;
  address: string;
}

// `from_field` and `send` are deliberately not part of this type. We want
// operators to set the From in Missive UI before clicking Send. The runtime
// guard below also throws if either field appears.
export interface CreateDraftInput {
  body: string;                       // can be HTML or plain
  subject?: string;
  to_fields?: MissiveRecipient[];     // array of {name?, address}
  cc_fields?: MissiveRecipient[];
  bcc_fields?: MissiveRecipient[];
  organization?: string;              // Missive organization id
  team?: string;                      // teamspace id (e.g. Auto Outbox Testing)
  conversation?: string;              // existing conversation id to attach to
  references?: string[];              // email Message-IDs for threading
  external_response?: { id: string }; // optional reference
  // Tags/labels — Missive allows passing label IDs here:
  add_users?: string[];
  add_assignees?: string[];
  add_to_inbox?: boolean;
  add_to_team_inbox?: boolean;
  // Plus arbitrary attachments aren't supported in this minimal client.
}

export interface MissiveDraft {
  id: string;                         // draft id
  conversation_id?: string;
  subject?: string;
  body?: string;
  created_at?: string;
}

const SAFETY_BANNED_KEYS = new Set(["send", "from_field"]);

function assertNoSendOrFromField(input: Record<string, unknown>) {
  for (const k of Object.keys(input)) {
    if (SAFETY_BANNED_KEYS.has(k)) {
      const detail = `Banned field "${k}" present in draft payload (subject="${(input.subject as string) ?? ""}").`;
      // Fire-and-forget Slack DM; this should never happen, so loud failure mode is intentional.
      void (async () => {
        try {
          const { alertMissiveFromField } = await import("@/lib/safety-alerts");
          await alertMissiveFromField(detail);
        } catch (e) { console.error("[safety-alerts] from_field alert failed:", e); }
      })();
      throw new Error(
        `[missive client safety] Refusing to POST a draft that includes "${k}". ` +
        `from_field must remain empty (operator picks the sender) and send must never be true (operator clicks Send).`
      );
    }
  }
}

export async function createMissiveDraft(input: CreateDraftInput): Promise<MissiveDraft> {
  const token = process.env.MISSIVE_API_TOKEN;
  if (!token) throw new Error("MISSIVE_API_TOKEN not configured");

  const payload: Record<string, unknown> = { ...input };
  // Be paranoid: scrub banned fields even if they snuck in via a malformed cast.
  for (const k of SAFETY_BANNED_KEYS) delete payload[k];
  assertNoSendOrFromField(payload);

  const res = await fetch(`${MISSIVE_BASE}/drafts`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ drafts: payload }),  // Missive wraps the payload
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Missive POST /drafts failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const body = await res.json();
  // The response shape Missive returns is { drafts: { id, conversation, ... } }
  const drafts = body.drafts ?? body;
  return {
    id: drafts.id ?? drafts.draft?.id ?? "",
    conversation_id: drafts.conversation ?? drafts.conversation_id,
    subject: drafts.subject,
    body: drafts.body,
    created_at: drafts.created_at,
  };
}

// Build a Missive UI URL for a given thread+draft so operators can deep-link in.
export function missiveDraftLink(conversationId: string, draftId: string): string {
  return `https://mail.missiveapp.com/#inbox/conversations/${conversationId}/drafts/${draftId}`;
}

// ---------- Read helpers (used by Agent 08 — Email Scanner) ----------
//
// The Missive API requires a mailbox filter on /conversations (it returns 400
// otherwise — "You need to paginate at least one mailbox"). team_all returns
// every conversation in a team's mailbox; that's the filter Agent 08 needs.

export interface MissiveConversation {
  id: string;
  subject: string | null;
  latest_message_subject: string | null;
  last_activity_at: number; // unix seconds
  created_at: number;
  messages_count: number;
  drafts_count: number;
  external_authors: Array<{ name?: string; address: string }>;
}

export interface MissiveAttachment {
  id: string;
  filename: string;
  extension: string | null;
  // Signed, time-limited URL — fetch directly, no auth header needed.
  url: string;
  media_type: string | null; // "image" | "file" | ...
  sub_type: string | null; // "png" | "pdf" | ...
  size: number | null;
}

export interface MissiveMessage {
  id: string;
  created_at: number;
  subject?: string | null;
  preview?: string | null;
  from_field?: { name?: string; address?: string } | null;
  to_fields?: Array<{ name?: string; address?: string }>;
  attachments?: MissiveAttachment[];
  // True for drafts — Agent 08 ignores these.
  draft?: boolean;
}

async function missiveGet<T>(path: string): Promise<T> {
  const token = process.env.MISSIVE_API_TOKEN;
  if (!token) throw new Error("MISSIVE_API_TOKEN not configured");
  const res = await fetch(`${MISSIVE_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Missive GET ${path} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export async function listTeamConversations(teamId: string, limit = 50): Promise<MissiveConversation[]> {
  const body = await missiveGet<{ conversations: MissiveConversation[] }>(
    `/conversations?team_all=${encodeURIComponent(teamId)}&limit=${limit}`
  );
  return body.conversations ?? [];
}

// Conversations tagged with a given shared label (used by Agent 13 to scope to
// a single client's correspondence, e.g. the "Bobber Labs" label).
export async function listLabelConversations(sharedLabelId: string, limit = 50): Promise<MissiveConversation[]> {
  const body = await missiveGet<{ conversations: MissiveConversation[] }>(
    `/conversations?shared_label=${encodeURIComponent(sharedLabelId)}&limit=${limit}`
  );
  return body.conversations ?? [];
}

// Missive caps this endpoint at limit=10 (returns 400 otherwise). We clamp.
export async function getConversationMessages(conversationId: string, limit = 10): Promise<MissiveMessage[]> {
  const safeLimit = Math.min(Math.max(1, limit), 10);
  const body = await missiveGet<{ messages: MissiveMessage[] }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages?limit=${safeLimit}`
  );
  return body.messages ?? [];
}
