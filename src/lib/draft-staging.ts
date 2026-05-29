import type { createAdminClient } from "@/lib/supabase/admin";
import { createMissiveDraft, missiveDraftLink } from "@/lib/missive";
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
  agentId: string;
  runId: string;
  orgId: string | null;
  supplierId?: string | null;
  materialId?: string | null;
  quoteId?: string | null;
  to: { name?: string | null; address: string };
  subject: string;
  body: string; // plain text; converted to HTML for Missive, sliced for preview
  assignedOperator?: string | null;
  // Caller-supplied metadata (outreach_mode, ghost_brand, lead_id, etc.).
  // qa_findings + missive_draft_link are merged in here.
  metadata?: Record<string, any>;
}

export interface StageDraftResult {
  ok: boolean;
  error?: string;
  draftRefId?: string;
  missiveDraftId?: string;
  conversationId?: string | null;
  qaFindings?: Finding[];
}

export async function stageDraft(input: StageDraftInput): Promise<StageDraftResult> {
  const { admin, agentId, runId, orgId, supplierId, materialId, quoteId, to, subject, body, assignedOperator } = input;
  const callerMeta = input.metadata ?? {};

  // Lint at creation time, on the same shape the scheduled QA sweep uses.
  const qaFindings = lintDraft({
    subject,
    body_preview: body,
    assigned_operator: assignedOperator ?? null,
    metadata: callerMeta,
  });

  let missiveDraft;
  try {
    missiveDraft = await createMissiveDraft({
      subject,
      body: bodyToHtml(body),
      to_fields: [{ name: to.name ?? "", address: to.address }],
      organization: MISSIVE_ORGANIZATION_ID,
      team: MISSIVE_TEAM_ID,
      add_to_team_inbox: true,
    });
  } catch (e: any) {
    return { ok: false, error: `missive: ${e?.message ?? e}`, qaFindings };
  }

  const metadata = {
    ...callerMeta,
    qa_findings: qaFindings,
    qa_linted_at: new Date().toISOString(),
    missive_draft_link: missiveDraft.conversation_id
      ? missiveDraftLink(missiveDraft.conversation_id, missiveDraft.id)
      : null,
  };

  const { data, error } = await admin
    .from("draft_references")
    .insert({
      email_client: "missive",
      thread_id: missiveDraft.conversation_id ?? "",
      draft_id: missiveDraft.id,
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
    missiveDraftId: missiveDraft.id,
    conversationId: missiveDraft.conversation_id ?? null,
    qaFindings,
  };
}
