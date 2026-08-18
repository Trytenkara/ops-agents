"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { freezeDerivedOwners } from "@/lib/freeze-assignments";
import { syncOrgThreadOwners } from "@/lib/sync-thread-owners";
import { ALL_SUPPLIER_TYPES, type AssignmentMode, type OperatorType } from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";

interface Result {
  ok: boolean;
  error?: string;
  frozen?: number;
  // Open threads this change moved to a different operator, and how many of those
  // the email app refused. Surfaced so an ops lead can see that a lane edit was
  // not just a label change, and that the inbox caught up with it.
  threadsMoved?: number;
  mirrorsFailed?: number;
}

const MODES: AssignmentMode[] = ["manual", "auto_new", "auto_all"];
const OPERATOR_TYPES: OperatorType[] = ["call", "email"];

export async function setOrgAssignmentSettings(input: {
  orgId: string;
  orgSlug?: string;
  mode: AssignmentMode;
  supplierTypes: MarketKind[];
}): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };
  if (!MODES.includes(input.mode)) return { ok: false, error: "unknown mode" };
  const types = input.supplierTypes.filter((t) => ALL_SUPPLIER_TYPES.includes(t));

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("orgs")
    .select("assignment_mode, assignment_supplier_types")
    .eq("id", input.orgId)
    .maybeSingle();

  const beforeTypes: MarketKind[] = Array.isArray((before as any)?.assignment_supplier_types)
    ? ((before as any).assignment_supplier_types as string[]).filter((t): t is MarketKind =>
        (ALL_SUPPLIER_TYPES as string[]).includes(t)
      )
    : ALL_SUPPLIER_TYPES;
  const dropped = beforeTypes.filter((t) => !types.includes(t));

  let frozen = 0;
  const goingManual = input.mode === "manual" && (before as any)?.assignment_mode !== "manual";
  if (goingManual || dropped.length > 0) {
    try {
      // Going manual pins everything; narrowing pins only what is leaving scope.
      frozen = await freezeDerivedOwners(admin, input.orgId, session.userId, goingManual ? null : dropped);
    } catch (e: any) {
      // Making the change without the snapshot would silently unassign the
      // suppliers it affects, so fail the whole change instead.
      return { ok: false, error: `could not pin current assignees: ${e.message}` };
    }
  }

  // Stamp only on the transition INTO auto_all. Re-saving the card (a scope edit,
  // say) must not move the stamp, or every override made since would fall behind
  // it and revert to the auto owner.
  const enteringAutoAll = input.mode === "auto_all" && (before as any)?.assignment_mode !== "auto_all";
  const patch: Record<string, unknown> = { assignment_mode: input.mode, assignment_supplier_types: types };
  if (enteringAutoAll) patch.assignment_auto_all_at = new Date().toISOString();

  const { error } = await admin.from("orgs").update(patch).eq("id", input.orgId);
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "org.assignment_settings_set",
    target_table: "orgs",
    target_id: input.orgId,
    diff: { from: before ?? null, to: patch, pinned_assignees: frozen },
  });
  if (input.orgSlug) revalidatePath(`/work/orgs/${input.orgSlug}`);
  return { ok: true, frozen };
}

// What kind of work one operator takes on one client: phone or email, and which
// market lanes. Held per (user, org), so somebody can be a caller for one client
// and on the email desk for another, and never both on the same one.
export async function setOperatorWork(input: {
  orgId: string;
  orgSlug?: string;
  userId: string;
  operatorType?: OperatorType;
  lanes?: MarketKind[];
}): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };

  const patch: Record<string, unknown> = {};
  if (input.operatorType) {
    if (!OPERATOR_TYPES.includes(input.operatorType)) return { ok: false, error: "unknown operator type" };
    patch.operator_type = input.operatorType;
  }
  if (input.lanes) {
    const lanes = input.lanes.filter((l) => ALL_SUPPLIER_TYPES.includes(l));
    // An operator on no lanes would silently drop out of every spread while still
    // looking assigned to the client, so an empty selection is rejected rather
    // than saved.
    if (!lanes.length) return { ok: false, error: "pick at least one lane" };
    patch.lanes = lanes;
  }
  if (!Object.keys(patch).length) return { ok: true };

  const admin = createAdminClient();
  const { error } = await admin
    .from("user_org_assignments")
    .update(patch)
    .eq("org_id", input.orgId)
    .eq("user_id", input.userId);
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "org.operator_work_set",
    target_table: "user_org_assignments",
    target_id: input.userId,
    diff: { org_id: input.orgId, ...patch },
  });
  // Lanes and desk type are inputs to the derived owner, so this edit just moved
  // threads. Control Room re-derives on the next render either way; the email app
  // only knows what it was last told, and left alone it keeps showing the previous
  // operator indefinitely.
  const sync = await syncOrgThreadOwners(admin, input.orgId).catch(() => null);
  if (input.orgSlug) revalidatePath(`/work/orgs/${input.orgSlug}`);
  return { ok: true, threadsMoved: sync?.moved, mirrorsFailed: sync?.mirrorsFailed };
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
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };

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
  // Same as a lane edit: taking someone out of the auto loop redistributes their
  // derived book, and the email app has to be told.
  const sync = await syncOrgThreadOwners(admin, input.orgId).catch(() => null);
  if (input.orgSlug) revalidatePath(`/work/orgs/${input.orgSlug}`);
  return { ok: true, threadsMoved: sync?.moved, mirrorsFailed: sync?.mirrorsFailed };
}
