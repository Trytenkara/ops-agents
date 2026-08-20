"use server";
import { getSession, hasAnyRole, type AppRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ASSIGNABLE_OPERATOR_ROLES } from "@/lib/operator-assignment";
import { reassignIneligibleOwners } from "@/lib/reassign-owners";
import { INTERACTIVE_SYNC_BUDGET_MS, syncOrgThreadOwners } from "@/lib/sync-thread-owners";

interface Result<T = void> { ok: boolean; error?: string; data?: T }

const INVITABLE_BY_LEAD: AppRole[] = ["ops_operator", "account_manager"];
const ALL_ROLES: AppRole[] = ["admin", "ops_lead", "ops_operator", "account_manager", "monitor"];
const ASSIGNABLE = new Set<string>(ASSIGNABLE_OPERATOR_ROLES);

// A role change, an org unassignment, or a deactivation can each leave an
// operator still holding suppliers/threads/leads for an org they can no longer
// work. Move that book onto whoever's left in the org's pool so nothing goes
// stale on the removed person (see reassignIneligibleOwners for why a stamped
// owner never self-heals).
async function reassignAcrossOrgs(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  actorUserId: string,
  orgIds?: string[]
) {
  const orgs =
    orgIds ??
    ((await admin.from("user_org_assignments").select("org_id").eq("user_id", userId)).data ?? []).map(
      (r: any) => r.org_id as string
    );
  for (const orgId of orgs) {
    await reassignIneligibleOwners(admin, orgId, [userId], actorUserId).catch(() => null);
  }
}

// Gaining an operator is the mirror image of losing one: the spread hands them
// roughly one share of every other operator's book. Control Room shows that on
// the next render; the Tenkara inbox keeps naming the previous owner until it is
// told, which is what operators see as "the email app disagrees with the Control
// Room". reassignIneligibleOwners covers the losing side, this covers the gaining
// side.
async function syncThreadsAcrossOrgs(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  orgIds?: string[]
) {
  const orgs =
    orgIds ??
    ((await admin.from("user_org_assignments").select("org_id").eq("user_id", userId)).data ?? []).map(
      (r: any) => r.org_id as string
    );
  for (const orgId of orgs) {
    await syncOrgThreadOwners(admin, orgId, {
      deadlineAt: Date.now() + INTERACTIVE_SYNC_BUDGET_MS,
    }).catch(() => null);
  }
}

function canInvite(actorRoles: AppRole[], targetRole: AppRole): boolean {
  if (actorRoles.includes("admin")) return true;
  if (actorRoles.includes("ops_lead")) return INVITABLE_BY_LEAD.includes(targetRole);
  return false;
}

export async function inviteOperator(input: {
  email: string;
  displayName: string;
  role: AppRole;
  orgIds: string[];
}): Promise<Result<{ user_id: string }>> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!ALL_ROLES.includes(input.role)) return { ok: false, error: "invalid role" };
  if (!canInvite(session.roles, input.role)) return { ok: false, error: "your role can't invite that role" };

  const admin = createAdminClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const redirectTo = `${appUrl}/auth/set-password`;

  // 1. Send the Supabase Auth invite email (creates auth.users row, sends magic link).
  const inviteRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      email: input.email,
      data: { name: input.displayName, invited_role: input.role },
      redirect_to: redirectTo,
    }),
  });
  const inviteBody: any = await inviteRes.json().catch(() => ({}));
  if (!inviteRes.ok) {
    return { ok: false, error: inviteBody.msg ?? inviteBody.error_description ?? `invite failed (${inviteRes.status})` };
  }
  const newUserId = inviteBody.id ?? inviteBody.user?.id;
  if (!newUserId) return { ok: false, error: "invite succeeded but no user id returned" };

  // 2. Upsert the public.users profile + role + org assignments + audit.
  await admin.from("users").upsert({
    id: newUserId,
    email: input.email,
    display_name: input.displayName || null,
    invited_by: session.userId,
    invited_at: new Date().toISOString(),
  });
  await admin.from("user_roles").upsert({ user_id: newUserId, role: input.role });
  if (input.orgIds.length > 0) {
    await admin.from("user_org_assignments").insert(
      input.orgIds.map((org_id) => ({
        user_id: newUserId, org_id, role: input.role, assigned_by: session.userId,
      }))
    );
  }
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "operator.invited",
    target_table: "users",
    target_id: newUserId,
    diff: { email: input.email, role: input.role, orgs: input.orgIds },
  });

  return { ok: true, data: { user_id: newUserId } };
}

export async function resendInvite(userId: string): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead"])) return { ok: false, error: "forbidden" };
  const admin = createAdminClient();
  const { data: target } = await admin.from("users").select("email").eq("id", userId).maybeSingle();
  if (!target?.email) return { ok: false, error: "user not found" };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ email: target.email, redirect_to: `${appUrl}/auth/set-password` }),
  });
  if (!r.ok) {
    const b: any = await r.json().catch(() => ({}));
    return { ok: false, error: b.msg ?? `resend failed (${r.status})` };
  }
  await admin.from("audit_log").insert({
    actor_user_id: session.userId, action: "operator.invite_resent", target_table: "users", target_id: userId,
  });
  return { ok: true };
}

export async function changeUserRole(userId: string, newRole: AppRole): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!ALL_ROLES.includes(newRole)) return { ok: false, error: "invalid role" };
  if (!canInvite(session.roles, newRole)) return { ok: false, error: "your role can't grant that role" };

  const admin = createAdminClient();
  const { data: targetRoles } = await admin.from("user_roles").select("role").eq("user_id", userId);
  const targetRoleList = (targetRoles ?? []).map((r) => r.role as AppRole);
  if (targetRoleList.includes("admin") && !session.roles.includes("admin")) {
    return { ok: false, error: "only admins can modify admins" };
  }

  // Replace all roles with the single new role (we model one role per user in this UI).
  await admin.from("user_roles").delete().eq("user_id", userId);
  await admin.from("user_roles").insert({ user_id: userId, role: newRole });
  await admin.from("audit_log").insert({
    actor_user_id: session.userId, action: "operator.role_changed",
    target_table: "users", target_id: userId,
    diff: { from: targetRoleList, to: [newRole] },
  });
  // Losing ops_operator/ops_lead means every org this person is assigned to
  // just lost an eligible owner (e.g. demoted to monitor/admin). Hand off
  // whatever they were holding rather than leaving it stuck on them.
  const wasAssignable = targetRoleList.some((r) => ASSIGNABLE.has(r));
  if (wasAssignable && !ASSIGNABLE.has(newRole)) {
    await reassignAcrossOrgs(admin, userId, session.userId);
  } else if (!wasAssignable && ASSIGNABLE.has(newRole)) {
    await syncThreadsAcrossOrgs(admin, userId);
  }
  return { ok: true };
}

export async function setOrgAssignments(userId: string, orgIds: string[]): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead"])) return { ok: false, error: "forbidden" };
  const admin = createAdminClient();

  const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", userId).limit(1).maybeSingle();
  const role = (roleRow?.role as AppRole) ?? "ops_operator";

  // Lead operators can only assign within orgs they themselves cover. We don't enforce that yet —
  // assume Lead Operators are global within orgs they manage. Tighten in Phase G if needed.

  // Diff, never delete-and-reinsert. This row is not only membership: it also
  // holds the per-org work settings (auto_assignable, operator_type, lanes). A
  // reinserted row gets column DEFAULTS for anything the insert doesn't name, so
  // rewriting every row to change the org LIST silently reset settings an ops
  // lead had configured. That is not hypothetical: adding a team to a new client
  // wiped California Chemicals' lane split and both its call operators, and
  // re-owned 1,380 leads. Copying the columns forward one by one was the old
  // patch and it only covered auto_assignable, so the next two columns added to
  // this table reintroduced the bug. Touch only the orgs that actually changed
  // and the settings survive by construction, including ones added later.
  const { data: priorRows } = await admin
    .from("user_org_assignments")
    .select("org_id")
    .eq("user_id", userId);
  const priorOrgIds = (priorRows ?? []).map((r: any) => r.org_id as string);
  const added = orgIds.filter((id) => !priorOrgIds.includes(id));
  const kept = orgIds.filter((id) => priorOrgIds.includes(id));
  const removed = priorOrgIds.filter((id) => !orgIds.includes(id));

  if (removed.length > 0) {
    await admin.from("user_org_assignments").delete().eq("user_id", userId).in("org_id", removed);
  }
  if (added.length > 0) {
    await admin.from("user_org_assignments").insert(
      added.map((org_id) => ({ user_id: userId, org_id, role, assigned_by: session.userId }))
    );
  }
  // Kept rows still need the role synced (this runs alongside a role change),
  // but nothing else about them may be touched.
  if (kept.length > 0) {
    await admin.from("user_org_assignments").update({ role }).eq("user_id", userId).in("org_id", kept);
  }
  await admin.from("audit_log").insert({
    actor_user_id: session.userId, action: "operator.org_assignments_changed",
    target_table: "users", target_id: userId, diff: { orgs: orgIds },
  });
  // Orgs dropped from this person's list just lost them as an eligible owner.
  // Hand off whatever they held there so it doesn't go stale on someone no
  // longer covering that client.
  const droppedOrgIds = priorOrgIds.filter((id) => !orgIds.includes(id));
  if (droppedOrgIds.length > 0 && ASSIGNABLE.has(role)) {
    await reassignAcrossOrgs(admin, userId, session.userId, droppedOrgIds);
  }
  if (added.length > 0 && ASSIGNABLE.has(role)) {
    await syncThreadsAcrossOrgs(admin, userId, added);
  }
  return { ok: true };
}

export async function deactivateUser(userId: string): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead"])) return { ok: false, error: "forbidden" };
  if (userId === session.userId) return { ok: false, error: "can't deactivate yourself" };
  const admin = createAdminClient();
  const { data: targetRoles } = await admin.from("user_roles").select("role").eq("user_id", userId);
  if ((targetRoles ?? []).some((r) => r.role === "admin") && !session.roles.includes("admin")) {
    return { ok: false, error: "only admins can deactivate admins" };
  }
  await admin.from("users").update({
    deactivated_at: new Date().toISOString(),
    deactivated_by: session.userId,
  }).eq("id", userId);
  // Drop their auth session by banning the user — they can't log in until reactivated.
  await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ ban_duration: "876000h" }), // 100 years
  });
  await admin.from("audit_log").insert({
    actor_user_id: session.userId, action: "operator.deactivated",
    target_table: "users", target_id: userId,
  });
  // A deactivated operator can't work anything. Hand off whatever they held
  // across every org they were assigned to.
  await reassignAcrossOrgs(admin, userId, session.userId);
  return { ok: true };
}

export async function reactivateUser(userId: string): Promise<Result> {
  const session = await getSession();
  if (!session || !hasAnyRole(session, ["admin"])) return { ok: false, error: "forbidden" };
  const admin = createAdminClient();
  await admin.from("users").update({ deactivated_at: null, deactivated_by: null }).eq("id", userId);
  await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ ban_duration: "none" }),
  });
  await admin.from("audit_log").insert({
    actor_user_id: session.userId, action: "operator.reactivated",
    target_table: "users", target_id: userId,
  });
  // They are back in every pool they belong to, so their share of the spread
  // comes back with them. Tell the inbox.
  await syncThreadsAcrossOrgs(admin, userId);
  return { ok: true };
}
