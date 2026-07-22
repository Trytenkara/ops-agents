"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { getOrgOperatorPool } from "@/lib/operator-assignment";

interface Result {
  ok: boolean;
  error?: string;
}

// Assign (or clear) the operator who owns a single lead for a client. Used for
// Scout/AI-discovery leads that have no supplier_id (supplier-backed leads route
// through assignSupplierOperator instead). ops_operator can only assign/unassign
// THEMSELVES; ops_lead/admin can assign anyone in the org's operator pool.
// Passing operatorId=null clears the manual claim and reverts to the auto default.
export async function assignLeadOperator(orgId: string, leadId: string, operatorId: string | null): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  if (!orgId || !leadId) return { ok: false, error: "missing org or lead" };

  // Org access.
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) return { ok: false, error: "forbidden" };
  }

  const admin = createAdminClient();
  const isLead = hasAnyRole(session, ["admin", "ops_lead"]);

  if (operatorId === null) {
    // Operators may only clear their own claim.
    if (!isLead) {
      const { data: cur } = await admin
        .from("leads_in_flight")
        .select("assigned_operator_id")
        .eq("id", leadId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (cur?.assigned_operator_id && cur.assigned_operator_id !== session.userId)
        return { ok: false, error: "can only unassign yourself" };
    }
  } else {
    // Operators may only assign themselves.
    if (!isLead && operatorId !== session.userId) return { ok: false, error: "you can only assign yourself" };
    // The target must be an actual operator in this org's pool (or yourself).
    if (operatorId !== session.userId) {
      const pool = await getOrgOperatorPool(admin, orgId).catch(() => []);
      if (!pool.some((p) => p.id === operatorId)) return { ok: false, error: "not an operator for this client" };
    }
  }

  const { error } = await admin
    .from("leads_in_flight")
    .update({ assigned_operator_id: operatorId, updated_at: new Date().toISOString() })
    .eq("id", leadId)
    .eq("org_id", orgId);
  if (error) return { ok: false, error: error.message };

  // Re-point any in-flight manual-outreach case for this lead (Scout leads become
  // cases, keyed by lead_id in metadata; drafts aren't lead-keyed) so the change
  // takes effect on work already queued. Best-effort — never fails the assign.
  if (operatorId !== null) {
    await admin
      .from("cases")
      .update({ assigned_operator: operatorId })
      .eq("org_id", orgId)
      .eq("status", "open")
      .filter("metadata->>lead_id", "eq", leadId);
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: operatorId === null ? "lead.unassigned" : "lead.assigned",
    target_table: "leads_in_flight",
    target_id: orgId,
    diff: { lead_id: leadId, operator_id: operatorId },
  });

  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true };
}
