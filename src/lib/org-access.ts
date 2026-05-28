import type { SessionContext } from "@/lib/auth";
import { hasAnyRole } from "@/lib/auth";
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
