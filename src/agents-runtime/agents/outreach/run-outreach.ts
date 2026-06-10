import type { createAdminClient } from "@/lib/supabase/admin";
import { composeOutreachDraft } from "./drafter";
import { stageDraft } from "@/lib/draft-staging";
import { coldOutboundEmailClient } from "@/lib/tenkara";

// Per-lead outreach: compose the email, stage it through the shared draft→QA
// pipeline, and promote the lead to ready_for_outreach. Shared by Agent 04's
// scheduled sweep and Agent 03's inline call so both paths behave identically.

type Admin = ReturnType<typeof createAdminClient>;

export interface OutreachLead {
  id: string;
  org_id: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  material_id: string | null;
  material_name: string | null;
  payload: Record<string, any> | null;
}

export interface RunOutreachInput {
  admin: Admin;
  agentId: string;
  runId: string;
  lead: OutreachLead;
  email: string;
  contactName: string | null;
  mode: "active" | "ghost";
  ghostBrand?: string;
  clientOrgName: string;
  assignedOperator: string | null;
  log?: (msg: string, meta?: any) => Promise<void> | void;
}

export interface RunOutreachResult {
  staged: boolean;
  reason?: string;
  draftRefId?: string;
}

export async function runOutreachForLead(input: RunOutreachInput): Promise<RunOutreachResult> {
  const { admin, agentId, runId, lead, email, contactName, mode, ghostBrand, clientOrgName, assignedOperator } = input;
  const log = input.log ?? (async () => {});
  const payload = (lead.payload ?? {}) as any;

  const draft = composeOutreachDraft({
    mode,
    ghostBrand,
    clientOrgName,
    supplierContactName: contactName,
    supplierCompanyName: lead.supplier_name ?? null,
    materialName: lead.material_name ?? "the material",
    inciName: payload.inci_name ?? null,
    signal: payload.signal ?? null,
  });

  const emailClient = coldOutboundEmailClient("04");
  const staged = await stageDraft({
    admin,
    agentId,
    runId,
    orgId: lead.org_id,
    supplierId: lead.supplier_id,
    materialId: lead.material_id,
    to: { name: contactName, address: email },
    subject: draft.subject,
    body: draft.body,
    assignedOperator,
    emailClient,
    externalId: emailClient === "rod_app" ? `agent-04-outreach-${lead.id}` : undefined,
    metadata: {
      outreach_mode: mode,
      ghost_brand: ghostBrand ?? null,
      suggested_signoff: mode === "ghost" ? `${ghostBrand} Sourcing` : `${clientOrgName} Purchasing Team`,
      lead_id: lead.id,
    },
  });

  if (!staged.ok) {
    await log(`Outreach staging failed for ${lead.supplier_name} × ${lead.material_name}: ${staged.error}`, {
      step: "outreach",
      data: { lead_id: lead.id },
    });
    return { staged: false, reason: staged.error };
  }

  const newPayload = {
    ...payload,
    outreach: {
      email_client: emailClient,
      draft_id: staged.draftId ?? null,
      conversation_id: staged.conversationId ?? null,
      // back-compat: keep missive_* populated when staged into Missive
      missive_draft_id: emailClient === "missive" ? staged.missiveDraftId : null,
      missive_conversation_id: emailClient === "missive" ? (staged.conversationId ?? null) : null,
      mode,
      ghost_brand: ghostBrand ?? null,
      staged_at: new Date().toISOString(),
      staged_by_run_id: runId,
    },
  };
  const { error: upErr } = await admin
    .from("leads_in_flight")
    .update({ stage: "ready_for_outreach", payload: newPayload })
    .eq("id", lead.id);
  if (upErr) {
    await log(`Stage promotion failed for lead ${lead.id}: ${upErr.message}`, { step: "promote", data: { lead_id: lead.id } });
    // Draft is staged but the lead didn't promote — surface as partial.
    return { staged: true, reason: `promote_failed: ${upErr.message}`, draftRefId: staged.draftRefId };
  }

  await log(`Staged outreach draft: ${lead.supplier_name} → ${lead.material_name} (${mode})`, {
    step: "outreach",
    data: { lead_id: lead.id, draft_ref_id: staged.draftRefId, qa_findings: staged.qaFindings?.length ?? 0 },
  });
  return { staged: true, draftRefId: staged.draftRefId };
}
