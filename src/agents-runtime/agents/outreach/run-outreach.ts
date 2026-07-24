import type { createAdminClient } from "@/lib/supabase/admin";
import { composeOutreachDraft, type DraftMaterial } from "./drafter";
import { stageDraft } from "@/lib/draft-staging";
import { coldOutboundEmailClient, tenkaraEmailAccountIdFor } from "@/lib/tenkara";

// Short stable hash so a corrected/changed material set yields a NEW Tenkara
// externalId (Tenkara is idempotent on externalId — reusing it would return the
// old, wrong draft instead of regenerating).
function nameHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Per-supplier first contact: compose ONE email for the pool of materials passed
// in (the caller leads with a small pool, not the whole list — ops flow), stage
// it through the shared draft→QA pipeline, and promote those leads to
// ready_for_outreach. Materials not in the pool are held by the caller for a
// follow-up. Passing >1 material renders a bulleted multi-material RFQ.

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

export interface RunOutreachSupplierInput {
  admin: Admin;
  agentId: string;
  runId: string;
  orgId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  email: string;
  contactName: string | null;
  mode: "active" | "ghost";
  ghostBrand?: string;
  clientOrgName: string;
  assignedOperator: string | null;
  isMarketplace: boolean;
  // Every material we're sourcing from this supplier, one line item each.
  leads: OutreachLead[];
  log?: (msg: string, meta?: any) => Promise<void> | void;
}

export interface RunOutreachResult {
  staged: boolean;
  reason?: string;
  draftRefId?: string;
  promoted: number; // leads promoted to ready_for_outreach
}

export async function runOutreachForSupplier(input: RunOutreachSupplierInput): Promise<RunOutreachResult> {
  const { admin, agentId, runId, orgId, supplierId, supplierName, email, contactName, mode, ghostBrand, clientOrgName, assignedOperator, isMarketplace, leads } = input;
  const log = input.log ?? (async () => {});

  // Sort for determinism so the same material set always renders (and hashes)
  // identically across runs.
  const ordered = [...leads].sort((a, b) => (a.material_name ?? "").localeCompare(b.material_name ?? ""));
  const materials: DraftMaterial[] = ordered.map((l) => {
    const p = (l.payload ?? {}) as any;
    return { name: l.material_name ?? "the material", inciName: p.inci_name ?? p.inci ?? null };
  });
  const materialIds = ordered.map((l) => l.material_id).filter(Boolean) as string[];
  const materialNames = ordered.map((l) => l.material_name ?? "").filter(Boolean);
  const leadIds = ordered.map((l) => l.id);
  const primary = ordered[0];

  const draft = await composeOutreachDraft({
    mode,
    ghostBrand,
    clientOrgName,
    supplierContactName: contactName,
    supplierCompanyName: supplierName,
    // Consolidated caller passes the full material set; blank/whitespace names
    // are held upstream in index.ts, so materials[0].name is always real here.
    materialName: materials[0].name,
    inciName: materials[0].inciName ?? null,
    materials,
    signal: (primary.payload ?? {})?.signal ?? null,
    isMarketplace,
  });

  const emailClient = coldOutboundEmailClient("04");
  const emailAccountId = emailClient === "rod_app" ? tenkaraEmailAccountIdFor({ mode, clientOrgName, ghostBrand }) : undefined;
  if (emailClient === "rod_app" && !emailAccountId) {
    await log(`No Tenkara inbox mapped for brand "${mode === "ghost" ? ghostBrand : clientOrgName}" — staging without a sender; operator must pick`, {
      step: "outreach",
      data: { supplier_id: supplierId, mode, ghost_brand: ghostBrand ?? null },
    });
  }

  // Supplier-level idempotency key. The material-set hash means a changed set
  // (material added/removed/corrected) yields a fresh Tenkara conversation while
  // the caller supersedes the stale one.
  const supplierKey = supplierId ?? nameHash(email.toLowerCase());
  const externalId =
    emailClient === "rod_app"
      ? `agent-04-outreach-supplier-${supplierKey}-${nameHash(materialNames.map((n) => n.toLowerCase()).join("|"))}`
      : undefined;

  const staged = await stageDraft({
    admin,
    agentId,
    runId,
    orgId,
    supplierId,
    materialId: primary.material_id, // primary line item; full set carried in metadata
    to: { name: contactName, address: email },
    subject: draft.subject,
    body: draft.body,
    assignedOperator,
    emailClient,
    emailAccountId,
    supplierCompany: supplierName,
    externalId,
    metadata: {
      outreach_mode: mode,
      ghost_brand: ghostBrand ?? null,
      suggested_signoff: mode === "ghost" ? `${ghostBrand} Sourcing` : `${clientOrgName} Purchasing Team`,
      lead_id: primary.id,
      lead_ids: leadIds,
      supplier_name: supplierName ?? null,
      // Persist the recipient so the no-reply follow-up sweep can address nudges
      // (it reads metadata.supplier_contact_email, not the draft's to-address).
      supplier_contact_email: email,
      supplier_contact_name: contactName ?? null,
      // Consolidated draft covers several materials — carry the full set so the
      // Materials chip can mark every one as drafted, not just the primary.
      material_name: materialNames[0] ?? null,
      material_ids: materialIds,
      material_names: materialNames,
    },
  });

  if (!staged.ok) {
    await log(`Outreach staging failed for ${supplierName} × [${materialNames.join(", ")}]: ${staged.error}`, {
      step: "outreach",
      data: { supplier_id: supplierId, lead_ids: leadIds },
    });
    return { staged: false, reason: staged.error, promoted: 0 };
  }

  // Promote every lead in the group to point at the shared draft/conversation,
  // clearing any "compiling / awaiting siblings" hold.
  let promoted = 0;
  for (const l of ordered) {
    const payload = (l.payload ?? {}) as any;
    const { outreach_hold, ...rest } = payload;
    const newPayload = {
      ...rest,
      outreach: {
        email_client: emailClient,
        draft_id: staged.draftId ?? null,
        conversation_id: staged.conversationId ?? null,
        missive_draft_id: emailClient === "missive" ? staged.missiveDraftId : null,
        missive_conversation_id: emailClient === "missive" ? (staged.conversationId ?? null) : null,
        mode,
        ghost_brand: ghostBrand ?? null,
        consolidated_material_ids: materialIds,
        staged_at: new Date().toISOString(),
        staged_by_run_id: runId,
      },
    };
    const { error: upErr } = await admin
      .from("leads_in_flight")
      .update({ stage: "ready_for_outreach", payload: newPayload })
      .eq("id", l.id);
    if (upErr) {
      await log(`Stage promotion failed for lead ${l.id}: ${upErr.message}`, { step: "promote", data: { lead_id: l.id } });
      continue;
    }
    promoted++;
  }

  await log(`Staged consolidated outreach draft: ${supplierName} → [${materialNames.join(", ")}] (${mode})`, {
    step: "outreach",
    data: { supplier_id: supplierId, draft_ref_id: staged.draftRefId, materials: materialNames.length, qa_findings: staged.qaFindings?.length ?? 0 },
  });
  return { staged: true, draftRefId: staged.draftRefId, promoted };
}
