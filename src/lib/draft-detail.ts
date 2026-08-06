import { createAdminClient } from "@/lib/supabase/admin";
import { tenkaraInboxUrl } from "@/lib/tenkara";
import { operatorRoles, primaryRole } from "@/lib/operator";

// Human-readable labels for the agent-tracked conversation flow_status.
const FLOW_STATUS_LABEL: Record<string, string> = {
  outreach_sent: "Outreach sent",
  contacted: "Inquiry submitted",
  reply_received: "Reply received",
  responded: "We replied",
  awaiting_human: "Awaiting your input",
  bounced: "Bounced — bad address",
  price_captured: "Price captured",
  finalized: "Finalized",
  stale: "Stale — no price after follow-ups",
  closed_declined: "Closed — supplier declined",
  escalated_to_calling: "Escalated to a call",
  form_escalated: "Form routed to ops",
};

export type DraftPerson = { name: string | null; email: string | null; role: string | null };

export type DraftDetail = {
  id: string;
  orgId: string | null;
  orgSlug: string | null;
  orgName: string | null;
  subject: string | null;
  status: string;
  createdAt: string | null;
  agentName: string | null;
  supplierName: string | null;
  materialName: string | null;
  quoteId: string | null;
  threadId: string | null;
  bodyPreview: string | null;
  draftKind: string | null;
  isTenkara: boolean;
  inboxName: string;
  inboxUrl: string;
  assigned: DraftPerson | null;
  reviewer: DraftPerson | null;
  reviewedAt: string | null;
  flowLabel: string | null;
  followupCount: number;
  reply: {
    senderName: string | null;
    senderEmail: string | null;
    subject: string | null;
    preview: string | null;
    repliedAt: string | null;
  } | null;
};

function person(row: any): DraftPerson | null {
  if (!row) return null;
  return { name: row.display_name ?? null, email: row.email ?? null, role: primaryRole(operatorRoles(row)) };
}

export async function loadDraftDetail(draftId: string): Promise<DraftDetail | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("draft_references")
    .select(
      "*, orgs(slug, name), agents(name, slug), assigned:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), reviewer:users!draft_references_reviewer_fkey(display_name, email, user_roles(role))"
    )
    .eq("id", draftId)
    .maybeSingle();
  if (!data) return null;

  const d = data as any;
  const meta = (d.metadata ?? {}) as any;
  const reply = meta.reply_detected as any;
  const isTenkara = d.email_client === "rod_app" || d.email_client === "tenkara";

  return {
    id: d.id,
    orgId: d.org_id ?? null,
    orgSlug: d.orgs?.slug ?? null,
    orgName: d.orgs?.name ?? null,
    subject: d.subject ?? null,
    status: d.status,
    createdAt: d.created_at ?? null,
    agentName: d.agents?.name ?? null,
    supplierName: meta.supplier_name ?? d.supplier_id ?? null,
    materialName: meta.material_name ?? d.material_id ?? null,
    quoteId: d.quote_id ?? null,
    threadId: d.thread_id ?? null,
    bodyPreview: d.body_preview ?? null,
    draftKind: meta.draft_kind ?? null,
    isTenkara,
    inboxName: isTenkara ? "Tenkara Inbox" : "Missive",
    inboxUrl: isTenkara
      ? (meta.conversation_url ?? tenkaraInboxUrl(d.thread_id))
      : `https://mail.missiveapp.com/#inbox/conversations/${d.thread_id}/drafts/${d.draft_id}`,
    assigned: person(d.assigned),
    reviewer: person(d.reviewer),
    reviewedAt: d.reviewed_at ?? null,
    flowLabel: FLOW_STATUS_LABEL[meta.flow_status as string] ?? null,
    followupCount: Number(meta.followup_count ?? 0),
    reply: reply
      ? {
          senderName: reply.reply_sender_name ?? null,
          senderEmail: reply.reply_sender_email ?? null,
          subject: reply.reply_subject ?? null,
          preview: reply.reply_preview ?? null,
          repliedAt: reply.reply_unix_at ? new Date(reply.reply_unix_at * 1000).toISOString() : null,
        }
      : null,
  };
}
