"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { freezeDerivedOwners } from "@/lib/freeze-assignments";
import { ALL_SUPPLIER_TYPES, type AssignmentMode } from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";

interface Result {
  ok: boolean;
  error?: string;
  frozen?: number;
}

const MODES: AssignmentMode[] = ["manual", "auto_new", "auto_all"];

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
  if (input.orgSlug) revalidatePath(`/work/orgs/${input.orgSlug}`);
  return { ok: true };
}
