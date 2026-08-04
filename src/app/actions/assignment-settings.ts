"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAllPaged } from "@/lib/supabase-paging";
import { getClientSuppliers } from "@/lib/client-suppliers";
import {
  getOrgAssignmentContext,
  resolveOperatorId,
  ALL_SUPPLIER_TYPES,
  type AssignmentMode,
} from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";

interface Result {
  ok: boolean;
  error?: string;
  frozen?: number;
}

const MODES: AssignmentMode[] = ["manual", "auto_new", "auto_all"];

// Switching to manual has to leave today's owners exactly where they are, or an
// org would come back from the switch with every supplier unassigned. So before
// the mode flips, write the CURRENT derived owner into supplier_assignment for
// every supplier that has no claim yet: the auto spread's answer becomes the
// explicit one, and turning auto off changes nothing visible.
async function freezeDerivedOwners(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  actorUserId: string
): Promise<number> {
  const ctx = await getOrgAssignmentContext(admin, orgId);
  if (ctx.config.mode === "manual") return 0;

  const supplierIds = new Set<string>();
  const collect = async (table: "leads_in_flight" | "draft_references") => {
    const rows = await selectAllPaged<{ supplier_id: string | null }>((from, to) =>
      admin.from(table).select("supplier_id").eq("org_id", orgId).not("supplier_id", "is", null).order("supplier_id").range(from, to)
    ).catch(() => []);
    for (const r of rows) if (r.supplier_id) supplierIds.add(r.supplier_id);
  };
  await collect("leads_in_flight");
  await collect("draft_references");

  // The Suppliers tab lists the client's Tenkara suppliers, including ones with
  // no lead yet. They show an auto owner today, so they get frozen too.
  const { data: org } = await admin.from("orgs").select("tenkara_org_id").eq("id", orgId).maybeSingle();
  const tenkaraSuppliers = await getClientSuppliers(org?.tenkara_org_id ?? null).catch(() => null);
  if (tenkaraSuppliers) {
    for (const s of [
      ...tenkaraSuppliers.approved,
      ...tenkaraSuppliers.pending_review,
      ...tenkaraSuppliers.denied,
      ...tenkaraSuppliers.draft,
    ]) {
      supplierIds.add(s.id);
    }
  }

  const claims = [...supplierIds]
    .filter((sid) => !ctx.manual.has(sid))
    .map((sid) => ({ supplier_id: sid, operator_id: resolveOperatorId(ctx, sid) }))
    .filter((r): r is { supplier_id: string; operator_id: string } => !!r.operator_id);

  let frozen = 0;
  for (let i = 0; i < claims.length; i += 500) {
    const chunk = claims.slice(i, i + 500).map((c) => ({
      supplier_id: c.supplier_id,
      org_id: orgId,
      operator_id: c.operator_id,
      assigned_by: actorUserId,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await admin
      .from("supplier_assignment")
      .upsert(chunk, { onConflict: "supplier_id,org_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    frozen += chunk.length;
  }

  // Scout leads carry their operator on the lead, not on a supplier, so they need
  // the same treatment or their outreach falls back to the org's primary. Grouped
  // by operator to keep this a handful of updates instead of one per lead.
  const scout = await selectAllPaged<{ id: string; email: string | null }>((from, to) =>
    admin
      .from("leads_in_flight")
      .select("id, email:payload->>supplier_contact_email")
      .eq("org_id", orgId)
      .eq("status", "active")
      .is("supplier_id", null)
      .is("assigned_operator_id", null)
      .order("id")
      .range(from, to)
  ).catch(() => []);
  const byOperator = new Map<string, string[]>();
  for (const l of scout) {
    // Same key outreach uses, so the frozen owner matches who was getting drafts.
    const key = l.email ? `e:${l.email.trim().toLowerCase()}` : l.id;
    const opId = resolveOperatorId(ctx, key);
    if (!opId) continue;
    const ids = byOperator.get(opId) ?? [];
    ids.push(l.id);
    byOperator.set(opId, ids);
  }
  for (const [opId, ids] of byOperator) {
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await admin
        .from("leads_in_flight")
        .update({ assigned_operator_id: opId, updated_at: new Date().toISOString() })
        .in("id", ids.slice(i, i + 500));
      if (error) throw new Error(error.message);
      frozen += Math.min(500, ids.length - i);
    }
  }

  return frozen;
}

export async function setOrgAssignmentSettings(input: {
  orgId: string;
  orgSlug?: string;
  mode: AssignmentMode;
  supplierTypes: MarketKind[];
}): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead"])) return { ok: false, error: "forbidden" };
  if (!MODES.includes(input.mode)) return { ok: false, error: "unknown mode" };
  const types = input.supplierTypes.filter((t) => ALL_SUPPLIER_TYPES.includes(t));

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("orgs")
    .select("assignment_mode, assignment_supplier_types")
    .eq("id", input.orgId)
    .maybeSingle();

  let frozen = 0;
  if (input.mode === "manual" && (before as any)?.assignment_mode !== "manual") {
    try {
      frozen = await freezeDerivedOwners(admin, input.orgId, session.userId);
    } catch (e: any) {
      // Flipping to manual without the snapshot would silently unassign the
      // client's whole book, so fail the whole change instead.
      return { ok: false, error: `could not pin current assignees: ${e.message}` };
    }
  }

  const { error } = await admin
    .from("orgs")
    .update({ assignment_mode: input.mode, assignment_supplier_types: types })
    .eq("id", input.orgId);
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "org.assignment_settings_set",
    target_table: "orgs",
    target_id: input.orgId,
    diff: { from: before ?? null, to: { assignment_mode: input.mode, assignment_supplier_types: types }, pinned_assignees: frozen },
  });
  if (input.orgSlug) revalidatePath(`/work/orgs/${input.orgSlug}`);
  return { ok: true, frozen };
}

// Take one operator out of (or back into) an org's auto loop. Membership and
// manual assignability are untouched.
export async function setOperatorAutoAssignable(input: {
  orgId: string;
  orgSlug?: string;
  userId: string;
  autoAssignable: boolean;
}): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead"])) return { ok: false, error: "forbidden" };

  const admin = createAdminClient();
  const { error } = await admin
    .from("user_org_assignments")
    .update({ auto_assignable: input.autoAssignable })
    .eq("org_id", input.orgId)
    .eq("user_id", input.userId);
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "org.operator_auto_assignable_set",
    target_table: "user_org_assignments",
    target_id: input.userId,
    diff: { org_id: input.orgId, auto_assignable: input.autoAssignable },
  });
  if (input.orgSlug) revalidatePath(`/work/orgs/${input.orgSlug}`);
  return { ok: true };
}
