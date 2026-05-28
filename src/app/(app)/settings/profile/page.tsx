import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { OooToggle } from "@/components/ooo-toggle";
import { OperatorChip } from "@/components/operator-chip";
import { ChangePasswordForm } from "@/components/change-password-form";
import { rolesGlossary } from "@/lib/roles";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: orgAssignments } = await admin
    .from("user_org_assignments")
    .select("role, assigned_at, orgs(slug, name, is_internal)")
    .eq("user_id", session.userId)
    .order("assigned_at");

  const hasGlobalAccess = hasAnyRole(session, ["admin", "monitor"]);

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="font-serif text-3xl">Profile</h1>
        <p className="text-sm text-muted-foreground mt-1">Personal settings, roles, and org assignments.</p>
      </header>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Display name" value={session.displayName ?? "—"} />
          <Row label="Email" value={session.email} />
          <Row label="Roles" value={
            <div className="flex flex-wrap gap-1.5">
              {session.roles.length === 0 ? (
                <span className="text-muted-foreground">(no roles assigned — ask an admin)</span>
              ) : (
                session.roles.map((r) => <OperatorChip key={r} name="" role={r} />)
              )}
            </div>
          } />
        </CardContent>
      </Card>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Org assignments</CardTitle>
          <CardDescription>
            {hasGlobalAccess
              ? "Admins and Monitors see every org by default — explicit assignments below are optional."
              : "Orgs you're assigned to. Ask an Admin or a Lead Operator to change this."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasGlobalAccess && (orgAssignments?.length ?? 0) === 0 ? (
            <p className="text-sm">All orgs <span className="text-muted-foreground">(global access via {session.roles.includes("admin") ? "Admin" : "Monitor"} role)</span></p>
          ) : (orgAssignments?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No org assignments yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(orgAssignments ?? []).map((a: any) => (
                <li key={a.orgs?.slug} className="flex items-baseline justify-between">
                  <span>
                    {a.orgs?.name}
                    {a.orgs?.is_internal && <span className="ml-2 text-[9px] uppercase tracking-wider bg-secondary text-muted-foreground px-1.5 py-0.5 rounded">Internal</span>}
                  </span>
                  <OperatorChip name="" role={a.role} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Out of office</CardTitle>
          <CardDescription>While on, new items for orgs you're the primary on route to the backup.</CardDescription>
        </CardHeader>
        <CardContent>
          <OooToggle initialStatus={session.status} />
        </CardContent>
      </Card>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Password</CardTitle>
          <CardDescription>Set or change the password you'll use on the sign-in screen.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Roles glossary</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            {rolesGlossary().map((g) => (
              <li key={g.role} className="flex gap-3">
                <div className="w-32 shrink-0"><OperatorChip name="" role={g.role} /></div>
                <p className="text-muted-foreground">{g.blurb}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-start">
      <div className="text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  );
}
