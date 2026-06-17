import Link from "next/link";
import { getSession, hasAnyRole } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function LinkRow({ href, label, hint }: { href: string; label: string; hint?: string }) {
  return (
    <Link href={href} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-secondary/60">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <span className="text-muted-foreground text-sm">→</span>
    </Link>
  );
}

export default async function SettingsPage() {
  const session = (await getSession())!;
  const isAdmin = hasAnyRole(session, ["admin"]);
  const isMonitor = hasAnyRole(session, ["admin", "monitor"]);
  const isLead = hasAnyRole(session, ["admin", "ops_lead"]);

  return (
    <div className="space-y-6 max-w-3xl">
      <header>
        <h1 className="font-serif text-4xl tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-2">Your profile, team, and admin tools.</p>
      </header>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-0.5">
          <LinkRow href="/settings/profile" label="Profile" hint="Name, password, your role" />
        </CardContent>
      </Card>

      {(isLead || isMonitor) && (
        <Card className="tb-surface shadow-none">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Team & exports</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0.5">
            {isLead && <LinkRow href="/operators" label="Operators" hint="People and their client coverage" />}
            {isLead && <LinkRow href="/work/exports" label="Exports" hint="CSV bulk-upload archive" />}
          </CardContent>
        </Card>
      )}

      {isMonitor && (
        <Card className="tb-surface shadow-none">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">
              Agents <span className="ml-1 normal-case tracking-normal text-[11px]">· admin</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0.5">
            <LinkRow href="/agents" label="Activity feed" hint="What the agent fleet is doing" />
            {isAdmin && <LinkRow href="/agents/config" label="Configuration" hint="Prompts, schedules, training wheels" />}
            <LinkRow href="/agents/audit" label="Audit log" />
            <LinkRow href="/agents/health" label="System health" hint="Connectors and last runs" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
