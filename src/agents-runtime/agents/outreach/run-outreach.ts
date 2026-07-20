import type { createAdminClient } from "@/lib/supabase/admin";
import { composeOutreachDraft } from "./drafter";
import { stageDraft } from "@/lib/draft-staging";
import { coldOutboundEmailClient, tenkaraEmailAccountIdFor } from "@/lib/tenkara";

// Short stable hash so a corrected material name yields a NEW Tenkara externalId
// (Tenkara is idempotent on externalId — reusing it would return the old, wrong
// draft instead of regenerating).
function nameHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

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

// Consolidated variant: several leads for the SAME supplier, drafted into one
// email listing all their materials (#11). `leads` share supplier/contact/org.
export interface RunOutreachGroupInput extends Omit<RunOutreachInput, "lead"> {
  leads: OutreachLead[];
}

export interface RunOutreachResult {
  staged: boolean;
  reason?: string;
  draftRefId?: string;
  leadsPromoted?: number;
}

// One email for one supplier, covering 1..N of the client's materials. A single
// draft is staged and every lead in the group is promoted to point at it, so a
// supplier who can quote five materials gets one RFQ listing all five instead of
// five near-identical cold emails.
export async function runOutreachForSupplier(input: RunOutreachGroupInput): Promise<RunOutreachResult> {
  const { admin, agentId, runId, leads, email, contactName, mode, ghostBrand, clientOrgName, assignedOperator } = input;
  const log = input.log ?? (async () => {});
  if (leads.length === 0) return { staged: false, reason: "no leads" };

  const primary = leads[0];
  const payload = (primary.payload ?? {}) as any;

  // Marketplace flag is a property of the supplier, so any lead's signal applies.
  const isMarketplace = leads.some((l) => {
    const p = (l.payload ?? {}) as any;
    return (
      p.site_type === "M" ||
      p.site_type === "MS" ||
      p.supplier_role === "Marketplace" ||
      p.enrichment?.tenkara_supplier?.is_marketplace === true
    );
  });

  const materials = leads
    .map((l) => ({ name: (l.material_name ?? "").trim(), inci: (l.payload as any)?.inci_name ?? (l.payload as any)?.inci ?? null }))
    .filter((m) => m.name);

  const draft = composeOutreachDraft({
    mode,
    ghostBrand,
    clientOrgName,
    supplierContactName: contactName,
    supplierCompanyName: primary.supplier_name ?? null,
    materialName: primary.material_name ?? "the material",
    inciName: payload.inci_name ?? null,
    materials,
    signal: payload.signal ?? null,
    isMarketplace,
  });

  const emailClient = coldOutboundEmailClient("04");
  const emailAccountId = emailClient === "rod_app" ? tenkaraEmailAccountIdFor({ mode, clientOrgName, ghostBrand }) : undefined;
  if (emailClient === "rod_app" && !emailAccountId) {
    await log(`No Tenkara inbox mapped for brand "${mode === "ghost" ? ghostBrand : clientOrgName}" — staging without a sender; operator must pick`, {
      step: "outreach",
      data: { lead_id: primary.id, mode, ghost_brand: ghostBrand ?? null },
    });
  }
  // Stable externalId per supplier-group: primary lead + a hash of all material
  // names, so a corrected/added material regenerates rather than reusing a stale
  // Tenkara draft.
  const groupKey = materials.map((m) => m.name.toLowerCase()).sort().join("|");
  const staged = await stageDraft({
    admin,
    agentId,
    runId,
    orgId: primary.org_id,
    supplierId: primary.supplier_id,
    materialId: primary.material_id,
    to: { name: contactName, address: email },
    subject: draft.subject,
    body: draft.body,
    assignedOperator,
    emailClient,
    emailAccountId,
    supplierCompany: primary.supplier_name,
    externalId: emailClient === "rod_app" ? `agent-04-outreach-${primary.id}-${nameHash(groupKey)}` : undefined,
    metadata: {
      outreach_mode: mode,
      ghost_brand: ghostBrand ?? null,
      suggested_signoff: mode === "ghost" ? `${ghostBrand} Sourcing` : `${clientOrgName} Purchasing Team`,
      lead_id: primary.id,
      lead_ids: leads.map((l) => l.id),
      // Scout leads have no Tenkara supplier_id/material row, so the draft views
      // can't resolve names by id — carry them on the draft for display.
      supplier_name: primary.supplier_name ?? null,
      material_name: primary.material_name ?? null,
      // Consolidated outreach: every material this one email covers.
      consolidated: leads.length > 1,
      consolidated_materials: leads.map((l) => ({ id: l.material_id, name: l.material_name })),
    },
  });

  const label = materials.length > 1 ? `${materials.length} materials` : primary.material_name;
  if (!staged.ok) {
    await log(`Outreach staging failed for ${primary.supplier_name} × ${label}: ${staged.error}`, {
      step: "outreach",
      data: { lead_id: primary.id },
    });
    return { staged: false, reason: staged.error };
  }

  // Promote every lead in the group to point at the shared draft/thread.
  let leadsPromoted = 0;
  let promoteErr: string | undefined;
  for (const lead of leads) {
    const lp = (lead.payload ?? {}) as any;
    const newPayload = {
      ...lp,
      outreach: {
        email_client: emailClient,
        draft_id: staged.draftId ?? null,
        conversation_id: staged.conversationId ?? null,
        // back-compat: keep missive_* populated when staged into Missive
        missive_draft_id: emailClient === "missive" ? staged.missiveDraftId : null,
        missive_conversation_id: emailClient === "missive" ? (staged.conversationId ?? null) : null,
        mode,
        ghost_brand: ghostBrand ?? null,
        consolidated_with: leads.length > 1 ? leads.map((l) => l.id).filter((id) => id !== lead.id) : [],
        staged_at: new Date().toISOString(),
        staged_by_run_id: runId,
      },
    };
    const { error: upErr } = await admin
      .from("leads_in_flight")
      .update({ stage: "ready_for_outreach", payload: newPayload })
      .eq("id", lead.id);
    if (upErr) {
      promoteErr = upErr.message;
      await log(`Stage promotion failed for lead ${lead.id}: ${upErr.message}`, { step: "promote", data: { lead_id: lead.id } });
    } else {
      leadsPromoted++;
    }
  }

  await log(`Staged outreach draft: ${primary.supplier_name} → ${label} (${mode})${leads.length > 1 ? ` · ${leads.length} materials consolidated` : ""}`, {
    step: "outreach",
    data: { lead_id: primary.id, draft_ref_id: staged.draftRefId, leads: leads.length, qa_findings: staged.qaFindings?.length ?? 0 },
  });
  if (promoteErr) return { staged: true, reason: `promote_failed: ${promoteErr}`, draftRefId: staged.draftRefId, leadsPromoted };
  return { staged: true, draftRefId: staged.draftRefId, leadsPromoted };
}

// Single-lead outreach — thin wrapper over the supplier-group path. Kept for
// Agent 03's inline drain and any caller that has exactly one lead.
export async function runOutreachForLead(input: RunOutreachInput): Promise<RunOutreachResult> {
  const { lead, ...rest } = input;
  return runOutreachForSupplier({ ...rest, leads: [lead] });
}
