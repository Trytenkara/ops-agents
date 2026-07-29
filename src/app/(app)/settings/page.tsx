import Link from "next/link";
import { getSession, hasAnyRole } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createAdminClient } from "@/lib/supabase/admin";
import { ResetClientData } from "@/components/reset-client-data";
import { orgDisplayName } from "@/lib/org-display";
import { getApiUsage, type ProviderUsage } from "@/lib/api-usage";
import { formatUsd } from "@/lib/api-cost-rates";

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

  // Client list for the admin-only data-reset tool.
  let orgs: { id: string; name: string }[] = [];
  if (isAdmin) {
    const { data } = await createAdminClient().from("orgs").select("id, slug, name, display_name").order("name");
    orgs = (data ?? []).map((o: any) => ({ id: o.id, name: orgDisplayName(o) }));
  }

  // Estimated external-API usage/cost for the discovery providers (monitors+admins).
  let apiUsage: ProviderUsage[] = [];
  if (isMonitor) {
    apiUsage = await getApiUsage(createAdminClient());
  }
  const totalEstCost30d = apiUsage.reduce((sum, u) => sum + u.estCost30d, 0);
  const totalEstCostAll = apiUsage.reduce((sum, u) => sum + u.estCostAll, 0);

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

      {isMonitor && (
        <Card className="tb-surface shadow-none">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">
              API usage &amp; cost <span className="ml-1 normal-case tracking-normal text-[11px]">· estimated</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead className="text-right">Calls (30d)</TableHead>
                  <TableHead className="text-right">Calls (all)</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Leads landed</TableHead>
                  <TableHead className="text-right">Est. rate/call</TableHead>
                  <TableHead className="text-right">Est. cost (30d)</TableHead>
                  <TableHead className="text-right">Est. cost (all)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiUsage.map((u) => (
                  <TableRow key={u.rate.key}>
                    <TableCell className="font-medium">
                      {u.rate.label}
                      <span className="ml-2 text-[11px] uppercase tracking-wide text-muted-foreground">{u.rate.confidence}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{u.firedOk30d.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{u.firedOkAll.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{u.firedFailedAll.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{u.leadsLanded.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatUsd(u.rate.usdPerCall)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatUsd(u.estCost30d)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatUsd(u.estCostAll)}</TableCell>
                  </TableRow>
                ))}
                {apiUsage.length > 0 && (
                  <TableRow>
                    <TableCell className="font-semibold">Total</TableCell>
                    <TableCell />
                    <TableCell />
                    <TableCell />
                    <TableCell />
                    <TableCell />
                    <TableCell className="text-right font-semibold tabular-nums">{formatUsd(totalEstCost30d)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{formatUsd(totalEstCostAll)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                Estimates only. This app counts discovery calls fired by Agent 03 and leads that landed; true credit
                consumption and billing live in the remote discovery agent and each provider account, not here. Rates are
                editable in <code>lib/api-cost-rates.ts</code>.
              </p>
              {apiUsage.map((u) => (
                <p key={u.rate.key}>
                  <span className="font-medium text-foreground">{u.rate.label}:</span> {u.rate.assumption} (source: {u.rate.source})
                </p>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {isAdmin && (
        <Card className="tb-surface shadow-none border-destructive/30">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-destructive font-medium">
              Danger zone <span className="ml-1 normal-case tracking-normal text-[11px] text-muted-foreground">· admin</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResetClientData orgs={orgs} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
