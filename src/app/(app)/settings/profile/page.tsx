import { getSession } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { OooToggle } from "@/components/ooo-toggle";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = (await getSession())!;
  return (
    <div className="max-w-2xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Personal settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm">
            <div className="text-muted-foreground text-xs uppercase tracking-wider">Email</div>
            <div>{session.email}</div>
          </div>
          <div className="text-sm">
            <div className="text-muted-foreground text-xs uppercase tracking-wider">Display name</div>
            <div>{session.displayName ?? "—"}</div>
          </div>
          <div className="text-sm">
            <div className="text-muted-foreground text-xs uppercase tracking-wider">Roles</div>
            <div>{session.roles.length ? session.roles.join(", ") : "(no roles assigned — ask an admin)"}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Out of office</CardTitle>
          <CardDescription>When toggled on, new items for orgs where you're the primary operator route to the backup.</CardDescription>
        </CardHeader>
        <CardContent>
          <OooToggle initialStatus={session.status} />
        </CardContent>
      </Card>
    </div>
  );
}
