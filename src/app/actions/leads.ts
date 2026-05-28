"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";

interface ActionResult {
  ok: boolean;
  error?: string;
}

// Reasons an operator can pick when dropping a lead. Kept short and stable —
// surfaced as a dropdown in the UI; Agent 11 groups CSVs by reason.
export const DROP_REASONS = [
  { value: "duplicate", label: "Duplicate of an existing lead" },
  { value: "wrong_material", label: "Wrong material" },
  { value: "not_a_supplier", label: "Not actually a supplier" },
  { value: "already_relationship", label: "Already an active relationship" },
  { value: "low_quality_signal", label: "Low quality signal" },
  { value: "out_of_scope_geo", label: "Out of geographic scope" },
  { value: "other", label: "Other" },
] as const;
export type DropReason = (typeof DROP_REASONS)[number]["value"];

async function assertCanActOnLead(leadId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { error: "forbidden" as const };
  }
  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads_in_flight")
    .select("id, stage, status, org_id, payload")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "lead_not_found" as const };

  // Org gate: leads with a non-null org_id require the user to have access
  // (assignment, or a global role). Cross-org leads (null org_id) are
  // restricted to global roles.
  if (!seesAllOrgs(session)) {
    if (!lead.org_id) return { error: "forbidden" as const };
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(lead.org_id)) {
      return { error: "forbidden" as const };
    }
  }
  return { session, admin, lead };
}

export async function promoteLead(leadId: string): Promise<ActionResult> {
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;

  // Promote semantics: hand a lead to Agent 04 (Outreach). Acceptable
  // starting points are `enriched` (the happy path from Agent 06) and `raw`
  // with a blocked_reason (a human override saying "yes, contact them
  // anyway"). We park them on stage=ready_for_outreach so the next Agent 04
  // run picks them up.
  const fromStage = lead.stage as string;
  const blocked = (lead.payload as any)?.enrichment_blocked_reason;
  const isRawOverride = fromStage === "raw" && !!blocked;
  if (fromStage !== "enriched" && !isRawOverride) {
    return { ok: false, error: "lead_not_promotable" };
  }

  const { error } = await admin
    .from("leads_in_flight")
    .update({
      stage: "ready_for_outreach",
      payload: {
        ...((lead.payload as any) ?? {}),
        promoted_by: session.userId,
        promoted_at: new Date().toISOString(),
        ...(isRawOverride ? { promote_override: true } : {}),
      },
    })
    .eq("id", leadId)
    .eq("status", "active");
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "lead.promoted",
    target_table: "leads_in_flight",
    target_id: leadId,
    diff: { from_stage: fromStage, to_stage: "ready_for_outreach", override: isRawOverride || undefined },
  });

  revalidatePath("/work/leads");
  return { ok: true };
}

export async function dropLead(leadId: string, reason: DropReason, note?: string): Promise<ActionResult> {
  if (!DROP_REASONS.some((r) => r.value === reason)) {
    return { ok: false, error: "invalid_reason" };
  }
  const guard = await assertCanActOnLead(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;

  if (lead.status !== "active") return { ok: false, error: "lead_already_terminal" };

  const reasonText = note?.trim() ? `${reason}: ${note.trim()}` : reason;
  const { error } = await admin
    .from("leads_in_flight")
    .update({
      status: "terminal",
      drop_reason: reasonText,
      payload: {
        ...((lead.payload as any) ?? {}),
        dropped_by: session.userId,
        dropped_at: new Date().toISOString(),
        drop_reason_code: reason,
        ...(note?.trim() ? { drop_reason_note: note.trim() } : {}),
      },
    })
    .eq("id", leadId)
    .eq("status", "active");
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "lead.dropped",
    target_table: "leads_in_flight",
    target_id: leadId,
    diff: { from_stage: lead.stage, reason, note: note?.trim() || undefined },
  });

  revalidatePath("/work/leads");
  return { ok: true };
}
