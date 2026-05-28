import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { OperatorsTable } from "@/components/operators-table";
import { PageExplainer } from "@/components/page-explainer";

export const dynamic = "force-dynamic";

export default async function OperatorsPage() {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead"])) redirect("/work");

  const admin = createAdminClient();
  const [{ data: users }, { data: orgs }] = await Promise.all([
    admin
      .from("users")
      // user_org_assignments has two FKs to users (user_id + assigned_by); PostgREST
      // refuses to pick → PGRST201. Pin to the user_id relationship explicitly.
      .select("id, email, display_name, status, invited_at, last_login_at, deactivated_at, user_roles(role), user_org_assignments!user_org_assignments_user_id_fkey(orgs(slug, name))")
      .order("invited_at", { ascending: false, nullsFirst: true }),
    admin.from("orgs").select("id, slug, name, is_internal").order("name"),
  ]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Operators</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage who has access to Tackle Box, what role they have, and which orgs they work on.
        </p>
      </div>
      <PageExplainer tag="Access control.">
        Each operator's role determines what they can do; org assignments determine which client orgs they can see.
        Admins, Lead Operators and Monitors see every org; Operators and Account Managers see only their assigned orgs.
      </PageExplainer>
      <OperatorsTable
        actor={{ id: session.userId, roles: session.roles }}
        users={(users ?? []) as any}
        orgs={(orgs ?? []) as any}
      />
    </div>
  );
}
