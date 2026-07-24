"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { getOrgOperatorPool } from "@/lib/operator-assignment";
import { setTenkaraConversationAssignee } from "@/lib/tenkara";

interface Result {
  ok: boolean;
  error?: string;
}

// Mirror a supplier's Control Room assignment onto its Tenkara conversations so
// the email app shows the same assignee (and notifies only that operator). Runs
// against every rod_app thread staged for the supplier; best-effort — a mirror
// miss (unknown operator email, or a thread our token didn't create) is logged
// but never fails the local assignment. Pass operatorEmail=null to clear.
async function mirrorAssigneeToTenkara(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  supplierId: string,
  operatorEmail: string | null
): Promise<void> {
  const { data: refs } = await admin
    .from("draft_references")
    .select("thread_id")
    .eq("org_id", orgId)
    .eq("supplier_id", supplierId)
    .eq("email_client", "rod_app")
    .not("thread_id", "is", null);

  const threadIds = Array.from(
    new Set((refs ?? []).map((r: { thread_id: string | null }) => r.thread_id).filter((t): t is string => !!t))
  );
  if (threadIds.length === 0) return;

  const results = await Promise.all(threadIds.map((id) => setTenkaraConversationAssignee(id, operatorEmail)));
  results.forEach((res, i) => {
    if (!res.ok) {
      console.warn(`[assignSupplierOperator] Tenkara assignee mirror failed for conversation ${threadIds[i]}: ${res.status} ${res.error}`);
    }
  });
}

// Assign (or clear) the operator who owns a supplier for a client. ops_operator
// can only assign/unassign THEMSELVES; ops_lead/admin can assign anyone in the
// org's operator pool. Reassigning also moves the supplier's pending (un-sent)
// drafts to the new operator so the change takes effect immediately.
export async function assignSupplierOperator(orgId: string, supplierId: string, operatorId: string | null): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  if (!orgId || !supplierId) return { ok: false, error: "missing org or supplier" };

  // Org access.
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) return { ok: false, error: "forbidden" };
  }

  const admin = createAdminClient();
  const isLead = hasAnyRole(session, ["admin", "ops_lead"]);

  // Tenkara keys assignees by email; null clears the assignee on the mirror.
  let mirrorEmail: string | null = null;

  // Clear assignment.
  if (operatorId === null) {
    if (!isLead) {
      // Operators may only clear their own claim.
      const { data: cur } = await admin
        .from("supplier_assignment")
        .select("operator_id")
        .eq("org_id", orgId)
        .eq("supplier_id", supplierId)
        .maybeSingle();
      if (cur && cur.operator_id !== session.userId) return { ok: false, error: "can only unassign yourself" };
    }
    const { error } = await admin.from("supplier_assignment").delete().eq("org_id", orgId).eq("supplier_id", supplierId);
    if (error) return { ok: false, error: error.message };
  } else {
    // Operators may only assign themselves.
    if (!isLead && operatorId !== session.userId) return { ok: false, error: "you can only assign yourself" };
    // The target must be an actual operator in this org's pool (or yourself).
    if (operatorId !== session.userId) {
      const pool = await getOrgOperatorPool(admin, orgId).catch(() => []);
      if (!pool.some((p) => p.id === operatorId)) return { ok: false, error: "not an operator for this client" };
    }
    const { error } = await admin.from("supplier_assignment").upsert(
      {
        supplier_id: supplierId,
        org_id: orgId,
        operator_id: operatorId,
        assigned_by: session.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "supplier_id,org_id" }
    );
    if (error) return { ok: false, error: error.message };

    // Move the supplier's pending (un-sent) drafts to the new operator so the
    // assignment takes effect on work already in flight.
    await admin
      .from("draft_references")
      .update({ assigned_operator: operatorId })
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .in("status", ["staged", "reviewed"]);

    const { data: op } = await admin.from("users").select("email").eq("id", operatorId).maybeSingle();
    mirrorEmail = op?.email ?? null;
  }

  // Mirror onto the supplier's Tenkara conversations (best-effort). On assign we
  // only mirror once we have the operator's email — passing null there would
  // wrongly CLEAR the Tenkara assignee. Unassign always mirrors (null = clear).
  if (operatorId === null || mirrorEmail) {
    await mirrorAssigneeToTenkara(admin, orgId, supplierId, mirrorEmail);
  } else {
    console.warn(`[assignSupplierOperator] skipped Tenkara mirror: operator ${operatorId} has no email`);
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: operatorId === null ? "supplier.unassigned" : "supplier.assigned",
    target_table: "supplier_assignment",
    target_id: orgId,
    diff: { supplier_id: supplierId, operator_id: operatorId },
  });

  revalidatePath("/work/orgs/[slug]/suppliers", "page");
  return { ok: true };
}
