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

  // A supplier is owned by one operator, so the claim covers the supplier's whole
  // book, not the single material row that was clicked. Assigning one row left its
  // siblings on the auto owner, which is how one supplier ended up reading two
  // different operators down the Leads tab.
  const { data: clicked } = await admin
    .from("leads_in_flight")
    .select("supplier_name")
    .eq("id", leadId)
    .eq("org_id", orgId)
    .maybeSingle();
  const siblingName = (clicked?.supplier_name ?? "").trim();
  // ILIKE reads % and _ as wildcards, and supplier names do carry them.
  const pattern = siblingName.replace(/[\\%_]/g, (c: string) => `\\${c}`);
  const { data: siblings } = siblingName
    ? await admin
        .from("leads_in_flight")
        .select("id")
        .eq("org_id", orgId)
        .eq("status", "active")
        // Supplier-backed rows read their owner from supplier_assignment, so leave
        // them to assignSupplierOperator rather than writing a competing record.
        .is("supplier_id", null)
        .ilike("supplier_name", pattern)
    : { data: null };
  const targetIds = Array.from(new Set([leadId, ...((siblings ?? []) as { id: string }[]).map((r) => r.id)]));

  const now = new Date().toISOString();
  const { error } = await admin
    .from("leads_in_flight")
    // assigned_operator_at, not updated_at: every enrichment pass moves updated_at,
    // so it can't tell an operator's claim from an agent's touch, and auto_all
    // needs that distinction to know which claims override its spread.
    .update({ assigned_operator_id: operatorId, assigned_operator_at: operatorId ? now : null, updated_at: now })
    .in("id", targetIds)
    .eq("org_id", orgId);
  if (error) return { ok: false, error: error.message };

  // Re-point any in-flight manual-outreach case for those leads (Scout leads
  // become cases, keyed by lead_id in metadata; drafts aren't lead-keyed) so the
  // change takes effect on work already queued. Best-effort — never fails the
  // assign.
  if (operatorId !== null) {
    await admin
      .from("cases")
      .update({ assigned_operator: operatorId })
      .eq("org_id", orgId)
      .eq("status", "open")
      .in("metadata->>lead_id", targetIds);
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
