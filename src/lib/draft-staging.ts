import type { createAdminClient } from "@/lib/supabase/admin";
import { createMissiveDraft, missiveDraftLink } from "@/lib/missive";
import { createTenkaraDraft, createTenkaraConversation } from "@/lib/tenkara";
import { bodyToHtml } from "@/lib/email-style";
import { MISSIVE_ORGANIZATION_ID, MISSIVE_TEAM_ID } from "@/agents-runtime/agents/quote-revalidation/config";
import { lintDraft, type Finding } from "@/agents-runtime/agents/outreach-qa/lint";

// Shared draft → QA building block. Every intake agent (02 expiries,
// 03 new-material outreach, 08 inbound replies) composes its own copy, then
// calls this to: stage a Missive draft (never sends), run the Agent 10 QA lint
// inline, and write the draft_references pointer with qa_findings attached.
//
// This replaces the duplicated Missive-create + draft_references-insert blocks
// that lived in agents 02 and 04, and means QA runs at creation time instead of
// only on the hourly sweep.

type Admin = ReturnType<typeof createAdminClient>;

export interface StageDraftInput {
  admin: Admin;
  agentId: string | null;
  runId: string | null;
  orgId: string | null;
  supplierId?: string | null;
  materialId?: string | null;
  quoteId?: string | null;
  to: { name?: string | null; address: string };
  subject: string;
  body: string; // plain text; converted to HTML for the email client, sliced for preview
  assignedOperator?: string | null;
  // Which email app to stage into. "missive" (default) POSTs a Missive draft;
  // "rod_app" POSTs a Tenkara draft and requires conversationId (Phase 1 = replies only).
  emailClient?: "missive" | "rod_app";
  // For emailClient="rod_app": pass conversationId to reply into an existing thread,
  // OR externalId to create a brand-new cold-outbound conversation. One is required.
  conversationId?: string | null;
  externalId?: string | null; // idempotency key for cold-outbound conversation creates
  // Caller-supplied metadata (outreach_mode, ghost_brand, lead_id, etc.).
  // qa_findings + the draft link are merged in here.
  metadata?: Record<string, any>;
}

export interface StageDraftResult {
  ok: boolean;
  error?: string;
  draftRefId?: string;
  draftId?: string;           // the email client's draft id (Missive draft id or Tenkara draft UUID)
  missiveDraftId?: string;    // kept for back-compat with existing Missive callers
  conversationId?: string | null;
  qaFindings?: Finding[];
}

export async function stageDraft(input: StageDraftInput): Promise<StageDraftResult> {
  const { admin, agentId, runId, orgId, supplierId, materialId, quoteId, to, subject, body, assignedOperator } = input;
  const callerMeta = input.metadata ?? {};
  const emailClient = input.emailClient ?? "missive";

  // Lint at creation time, on the same shape the scheduled QA sweep uses.
  const qaFindings = lintDraft({
    subject,
    body_preview: body,
    assigned_operator: assignedOperator ?? null,
    metadata: callerMeta,
  });

  // Create the draft in the target email app. Both paths only stage — never send.
  let draftId: string;
  let threadId: string;
  let draftLink: string | null = null;
  const extraMeta: Record<string, any> = {};
  try {
    if (emailClient === "rod_app") {
      if (input.conversationId) {
        // Reply into an existing Tenkara conversation.
        const t = await createTenkaraDraft({
          conversationId: input.conversationId,
          to: { name: to.name ?? "", address: to.address },
          subject,
          bodyHtml: bodyToHtml(body),
          bodyText: body,
        });
        draftId = t.id;
        threadId = t.conversationId;
      } else if (input.externalId) {
        // Cold outbound: create a brand-new conversation + draft.
        const c = await createTenkaraConversation({
          externalId: input.externalId,
          to: { name: to.name ?? "", address: to.address },
          subject,
          bodyHtml: bodyToHtml(body),
          bodyText: body,
          context: { org_id: orgId, supplier_id: supplierId ?? null, material_id: materialId ?? null, quote_id: quoteId ?? null, ...callerMeta },
        });
        draftId = c.draftId;
        threadId = c.conversationId;
        extraMeta.draft_kind = callerMeta.draft_kind ?? "cold_outbound";
        extraMeta.external_id = input.externalId;
        extraMeta.requires_sender_selection = c.requiresSenderSelection;
      } else {
        return { ok: false, error: "rod_app drafts require conversationId (reply) or externalId (cold outbound)", qaFindings };
      }
    } else {
      const m = await createMissiveDraft({
        subject,
        body: bodyToHtml(body),
        to_fields: [{ name: to.name ?? "", address: to.address }],
        organization: MISSIVE_ORGANIZATION_ID,
        team: MISSIVE_TEAM_ID,
        add_to_team_inbox: true,
      });
      draftId = m.id;
      threadId = m.conversation_id ?? "";
      draftLink = m.conversation_id ? missiveDraftLink(m.conversation_id, m.id) : null;
    }
  } catch (e: any) {
    return { ok: false, error: `${emailClient}: ${e?.message ?? e}`, qaFindings };
  }

  const metadata = {
    ...callerMeta,
    qa_findings: qaFindings,
    qa_linted_at: new Date().toISOString(),
    missive_draft_link: draftLink,
    ...extraMeta,
  };

  const { data, error } = await admin
    .from("draft_references")
    .insert({
      email_client: emailClient,
      thread_id: threadId,
      draft_id: draftId,
      agent_id: agentId,
      agent_run_id: runId,
      org_id: orgId,
      supplier_id: supplierId ?? null,
      material_id: materialId ?? null,
      quote_id: quoteId ?? null,
      subject,
      body_preview: body.slice(0, 1500),
      assigned_operator: assignedOperator ?? null,
      metadata,
    })
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `draft_references: ${error.message}`, qaFindings };

  return {
    ok: true,
    draftRefId: data?.id,
    draftId,
    missiveDraftId: emailClient === "missive" ? draftId : undefined,
    conversationId: threadId || null,
    qaFindings,
  };
}
