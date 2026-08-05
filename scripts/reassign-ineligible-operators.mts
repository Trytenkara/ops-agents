// reassignIneligibleOwners (and the three action call sites that trigger it) only
// fire on a FUTURE role change, org unassignment, or deactivation. Anyone who was
// already ineligible before that code existed (role changed away from
// ops_operator/ops_lead, or deactivated, while still carrying user_org_assignments
// rows) is still holding stale supplier_assignment claims, draft_references, and
// leads_in_flight rows today. This sweeps every org once, finds whoever is
// currently assigned to it but not in ASSIGNABLE_OPERATOR_ROLES (or deactivated),
// and reassigns their book onto the live pool, mirroring drafts to Tenkara.
//
// Run:
//   npx tsx -r dotenv/config scripts/reassign-ineligible-operators.mts [--dry-run]
import { createAdminClient } from "@/lib/supabase/admin";
import { ASSIGNABLE_OPERATOR_ROLES } from "@/lib/operator-assignment";
import { reassignIneligibleOwners } from "@/lib/reassign-owners";

const dryRun = process.argv.includes("--dry-run");
const ASSIGNABLE = new Set<string>(ASSIGNABLE_OPERATOR_ROLES);

async function main() {
  const admin = createAdminClient();

  // assigned_by is an FK to users(id), so it needs a real actor. Any live admin
  // works; this is only an audit trail column, not a permission check.
  const { data: adminUserRoles } = await admin.from("user_roles").select("user_id").eq("role", "admin").limit(1);
  const actorUserId: string | null = adminUserRoles?.[0]?.user_id ?? null;
  if (!actorUserId && !dryRun) {
    console.error("no admin user found to attribute the reassignment to; aborting");
    process.exit(1);
  }

  const { data: orgs } = await admin.from("orgs").select("id, slug");

  for (const org of orgs ?? []) {
    const { data: assigns } = await admin
      .from("user_org_assignments")
      .select(
        "user_id, users:users!user_org_assignments_user_id_fkey(id, display_name, email, deactivated_at, user_roles(role))"
      )
      .eq("org_id", org.id);

    const ineligible = (assigns ?? []).filter((a: any) => {
      const u = a.users;
      if (!u) return false;
      const roles: string[] = (u.user_roles ?? []).map((r: any) => r.role);
      const hasAssignableRole = roles.some((r) => ASSIGNABLE.has(r));
      return !!u.deactivated_at || !hasAssignableRole;
    });
    if (ineligible.length === 0) continue;

    const names = ineligible.map((a: any) => a.users.display_name ?? a.users.email ?? a.users.id);
    console.log(`${org.slug}: ineligible owners still assigned: ${names.join(", ")}`);
    if (dryRun) continue;

    const result = await reassignIneligibleOwners(
      admin,
      org.id,
      ineligible.map((a: any) => a.users.id),
      actorUserId!
    );
    console.log(`  reassigned claims=${result.claims} drafts=${result.drafts} leads=${result.leads}`);

    // The ineligible person no longer belongs in this org's assignment pool at all.
    await admin.from("user_org_assignments").delete().eq("org_id", org.id).in(
      "user_id",
      ineligible.map((a: any) => a.users.id)
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
