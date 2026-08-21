import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPaged } from "@/lib/supabase-paging";
import { getOrgAssignmentContext, pickSupplierOperator, orgAutoKey, poolForWork } from "@/lib/operator-assignment";
import { mirrorDraftAssignee } from "@/lib/draft-staging";

export interface ReassignResult {
  claims: number;
  drafts: number;
  leads: number;
  cases: number;
}

// When an operator stops being eligible for an org (role changed away from
// ops_operator/ops_lead, deactivated, or unassigned from the org), whatever they
// were holding needs a live owner or it stays stale forever: supplier_assignment
// claims are only read, never re-derived, and draft_references/leads_in_flight
// stamp an owner once at creation and never revisit it. Move everything the
// removed operator(s) held for this org onto the current pool, keyed the same
// way the auto spread keys it (orgAutoKey) so a supplier's claim, its drafts,
// and its leads all land on the SAME new owner instead of drifting apart.
export async function reassignIneligibleOwners(
  admin: SupabaseClient,
  orgId: string,
  ineligibleUserIds: string[],
  actorUserId: string
): Promise<ReassignResult> {
  const removed = Array.from(new Set(ineligibleUserIds.filter(Boolean)));
  const result: ReassignResult = { claims: 0, drafts: 0, leads: 0, cases: 0 };
  if (removed.length === 0) return result;

  const ctx = await getOrgAssignmentContext(admin, orgId);
  // The pool is read live, so it should already exclude anyone just removed;
  // filter again in case this call raced the role/assignment change landing.
  const stillRemoved = new Set(removed);
  const autoPool = ctx.autoPool.filter((p) => !stillRemoved.has(p.id));
  const anyPool = ctx.pool.filter((p) => !stillRemoved.has(p.id));
  // Prefer the auto pool so a supplier's new owner matches who the spread would
  // hand it to next; fall back to the full pool only if everyone left opted out
  // of auto-assignable, so a manual claim still finds a live owner.
  const pickPool = autoPool.length > 0 ? autoPool : anyPool;
  const pick = (key: string): string | null => pickSupplierOperator(pickPool, key)?.id ?? null;
  // Calls go over the client's callers only, and never degrade to the email
  // desk (AUTO-08). An empty call pool means the removed operator's calls come
  // back unowned, which is the state that gets a caller named.
  const callPool = poolForWork(pickPool, { type: "call", lane: null });
  const pickCaller = (key: string): string | null => pickSupplierOperator(callPool, key)?.id ?? null;
  if (pickPool.length === 0) return result; // nobody left to take the book; leave it for a human to sort out

  // 1. Manual supplier claims.
  const claimRows = await selectAllPaged<{ supplier_id: string }>((from, to) =>
    admin
      .from("supplier_assignment")
      .select("supplier_id")
      .eq("org_id", orgId)
      .in("operator_id", removed)
      .order("supplier_id")
      .range(from, to)
  ).catch(() => []);
  for (const r of claimRows) {
    const newOwner = pick(r.supplier_id);
    if (!newOwner) continue;
    const { error } = await admin
      .from("supplier_assignment")
      .update({ operator_id: newOwner, assigned_by: actorUserId, updated_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("supplier_id", r.supplier_id);
    if (!error) result.claims++;
  }

  // 2. Threads (draft_references), and their mirror on the Tenkara side: the
  // conversation's assignee is pushed there once at draft-staging time and never
  // revisited, so a bare local update would leave the email app still showing the
  // removed operator. Scout drafts carry no supplier_id, so pull the lead they
  // were drafted from (metadata.lead_id) to key them the same way outreach did
  // when it first stamped an owner.
  const draftRows = await selectAllPaged<{ id: string; supplier_id: string | null; thread_id: string | null; metadata: any }>(
    (from, to) =>
      admin
        .from("draft_references")
        .select("id, supplier_id, thread_id, metadata")
        .eq("org_id", orgId)
        .in("assigned_operator", removed)
        .order("id")
        .range(from, to)
  ).catch(() => []);
  const leadIdsNeeded = Array.from(
    new Set(draftRows.filter((d) => !d.supplier_id).map((d) => d.metadata?.lead_id).filter((id): id is string => !!id))
  );
  const leadKeyById = new Map<string, string>();
  for (let i = 0; i < leadIdsNeeded.length; i += 200) {
    const { data } = await admin
      .from("leads_in_flight")
      .select("id, supplier_id, supplier_name, email:payload->>supplier_contact_email")
      .in("id", leadIdsNeeded.slice(i, i + 200));
    for (const l of (data ?? []) as { id: string; supplier_id: string | null; supplier_name: string | null; email: string | null }[]) {
      leadKeyById.set(l.id, orgAutoKey(ctx, { supplierId: l.supplier_id, supplierName: l.supplier_name, email: l.email, leadId: l.id }));
    }
  }
  for (const d of draftRows) {
    const key = d.supplier_id ?? leadKeyById.get(d.metadata?.lead_id) ?? d.id;
    const newOwner = pick(key);
    if (!newOwner) continue;
    const { error } = await admin.from("draft_references").update({ assigned_operator: newOwner }).eq("id", d.id);
    if (error) continue;
    result.drafts++;
    await mirrorDraftAssignee(admin, d.thread_id, newOwner);
  }

  // 3. Active leads.
  const leadRows = await selectAllPaged<{ id: string; supplier_id: string | null; supplier_name: string | null; email: string | null }>(
    (from, to) =>
      admin
        .from("leads_in_flight")
        .select("id, supplier_id, supplier_name, email:payload->>supplier_contact_email")
        .eq("org_id", orgId)
        .eq("status", "active")
        .in("assigned_operator_id", removed)
        .order("id")
        .range(from, to)
  ).catch(() => []);
  for (const l of leadRows) {
    const key = orgAutoKey(ctx, { supplierId: l.supplier_id, supplierName: l.supplier_name, email: l.email, leadId: l.id });
    const newOwner = pick(key);
    if (!newOwner) continue;
    const { error } = await admin
      .from("leads_in_flight")
      .update({ assigned_operator_id: newOwner, updated_at: new Date().toISOString() })
      .eq("id", l.id);
    if (!error) result.leads++;
  }

  // 4. Escalations, calls included. Every other tab derives its owner at read
  // time, but the stamp is what the agent posts to Slack and what an operator
  // filters their own queue by, so leaving it on somebody who no longer works
  // this client means the case is addressed to a name nobody answers to. Calls
  // route over the call pool and come back unowned rather than landing on the
  // email desk.
  const caseRows = await selectAllPaged<{ id: string; type: string | null; supplier_id: string | null; metadata: any }>(
    (from, to) =>
      admin
        .from("cases")
        .select("id, type, supplier_id, metadata")
        .eq("org_id", orgId)
        .in("status", ["open", "in_progress"])
        .in("assigned_operator", removed)
        .order("id")
        .range(from, to)
  ).catch(() => []);
  for (const c of caseRows) {
    const key = orgAutoKey(ctx, {
      supplierId: c.supplier_id,
      supplierName: (c.metadata?.supplier_name as string | undefined) ?? null,
      email: (c.metadata?.supplier_contact_email as string | undefined) ?? null,
      leadId: (c.metadata?.lead_id as string | undefined) ?? c.id,
    });
    const newOwner = c.type === "calling_escalation" ? pickCaller(key) : pick(key);
    // A call with no caller left is set unowned on purpose; desk work with no
    // pick is left alone, because the stored stamp is still its fallback.
    if (!newOwner && c.type !== "calling_escalation") continue;
    const { error } = await admin.from("cases").update({ assigned_operator: newOwner }).eq("id", c.id);
    if (!error) result.cases++;
  }

  return result;
}
