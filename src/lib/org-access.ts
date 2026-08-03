import type { SessionContext, AppRole } from "@/lib/auth";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Roles that see every org by default (no per-org assignment needed).
const GLOBAL_ROLES = ["admin", "ops_lead", "monitor"] as const;

export function seesAllOrgs(session: SessionContext): boolean {
  return hasAnyRole(session, [...GLOBAL_ROLES]);
}

// Returns the list of org_ids the user can read.
// - Global roles: returns null (caller should NOT filter — they see everything).
// - Everyone else: returns the org_ids from user_org_assignments (possibly empty).
//
// Pages that query org-scoped tables should call this and apply
// `.in("org_id", ids)` when the result is an array. RLS enforces the same
// rule at the DB layer, but we still filter in code because most pages use
// the service-role client which bypasses RLS.
export async function getAssignedOrgIds(session: SessionContext): Promise<string[] | null> {
  if (seesAllOrgs(session)) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("user_org_assignments")
    .select("org_id")
    .eq("user_id", session.userId);
  return (data ?? []).map((r: any) => r.org_id as string);
}

const WRITE_ROLES: AppRole[] = ["admin", "ops_lead", "ops_operator"];

// Gate for server actions that write org-scoped data: signed in, holds a write
// role, and (unless global) is assigned to this org. Returns the session plus a
// service-role client so callers don't re-create either.
export async function assertOrgWriteAccess(orgId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, WRITE_ROLES)) return { error: "forbidden" as const };
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) return { error: "forbidden" as const };
  }
  return { session, admin: createAdminClient() };
}
