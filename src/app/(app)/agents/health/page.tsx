import { redirect } from "next/navigation";
import { getSession, canSeeAgentTab, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { compareAgentsBySlug } from "@/lib/agents-sort";
import { HaltAllAgents } from "@/components/halt-all-agents";
import { getApiUsage } from "@/lib/api-usage";
import { formatUsd, UNMETERED_SERVICES } from "@/lib/api-cost-rates";
import { fetchHunterAccount, isHunterConfigured } from "@/lib/hunter";

export const dynamic = "force-dynamic";

const num = (n: number | null) => (n === null ? "—" : n.toLocaleString());
const usd = (n: number | null) => (n === null ? "—" : formatUsd(n));

export default async function SystemHealthPage() {
  const session = (await getSession())!;
  if (!canSeeAgentTab(session)) redirect("/");

  const admin = createAdminClient();
  const isAdmin = hasAnyRole(session, ["admin"]);
  const { data: agentsRaw } = await admin
    .from("agents")
    .select("name, slug, last_run_at, status, schedule_cron, schedule_tz, training_wheels");
  const haltedCount = (agentsRaw ?? []).filter((a: any) => a.training_wheels && a.slug !== "agent-01-ping").length;
  const agents = [...(agentsRaw ?? [])].sort(compareAgentsBySlug);
  const apiUsage = await getApiUsage(admin);
  const totalEstCost30d = apiUsage.reduce((sum, u) => sum + (u.estCost30d ?? 0), 0);
  const totalEstCostAll = apiUsage.reduce((sum, u) => sum + u.estCostAll, 0);

  // Hunter's remaining allowance, live. An exhausted plan is not an outage —
  // the waterfall keeps working by falling through to ZoomInfo, which is the
  // expensive one — so it has to be visible here or nobody finds out.
  const hunter = await fetchHunterAccount();
  const hunterNote = !isHunterConfigured()
    ? "missing HUNTER_API_KEY"
    : !hunter
    ? "configured (balance unavailable)"
    : `${hunter.planName} — ${hunter.remaining.toLocaleString()} of ${hunter.available.toLocaleString()} credits left${hunter.resetDate ? `, resets ${hunter.resetDate}` : ""}`;

  const checks = [
    { name: "Supabase (OA DB)", ok: true, note: "connected (this page loaded)" },
    { name: "Hunter.io credits", ok: !!hunter && hunter.remaining > 0, note: hunterNote },
    { name: "Slack bot token", ok: !!process.env.SLACK_BOT_TOKEN, note: process.env.SLACK_BOT_TOKEN ? "configured" : "missing" },
    { name: "Slack escalation channel", ok: !!process.env.SLACK_ESCALATION_CHANNEL_ID, note: process.env.SLACK_ESCALATION_CHANNEL_ID ?? "unset" },
    { name: "Service role key", ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY, note: process.env.SUPABASE_SERVICE_ROLE_KEY ? "configured" : "missing" },
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">System health</h1>
        <p className="text-sm text-muted-foreground mt-1">Connector status, last-run heartbeats, and estimated external-API usage and cost.</p>
      </div>

      {isAdmin && (
        <Card className="tb-surface shadow-none border-destructive/30">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Kill switch</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground max-w-md">
              Halts every agent except <code>agent-01-ping</code> by flipping <code>training_wheels=true</code>. The cron fan-out sees the flag and exits without acting. Use when something starts behaving unexpectedly — recoverable in one click.
            </p>
            <HaltAllAgents haltedCount={haltedCount} totalCount={agents.length} />
          </CardContent>
        </Card>
      )}

      <Card className="tb-surface shadow-none">
        <CardHeader><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Connectors</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {checks.map((c) => (
            <div key={c.name} className="flex items-center justify-between">
              <span>{c.name}</span>
              <span className="flex items-center gap-2">
                <Badge variant={c.ok ? "success" : "danger"}>{c.ok ? "OK" : "DOWN"}</Badge>
                <span className="text-xs text-muted-foreground">{c.note}</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="tb-surface shadow-none">
        <CardHeader><CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Last run per agent</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {agents.length === 0 && <p className="text-muted-foreground">No agents registered.</p>}
          {agents.map((a: any) => (
            <div key={a.slug} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                {a.name}
                {a.training_wheels && a.slug !== "agent-01-ping" && (
                  <Badge variant="danger" className="text-[10px]">Halted</Badge>
                )}
              </span>
              <span className="flex items-center gap-3 text-xs">
                {a.schedule_cron ? (
                  <code className="text-muted-foreground" title={`tz: ${a.schedule_tz ?? "Asia/Manila"}`}>{a.schedule_cron}</code>
                ) : (
                  <span className="text-muted-foreground italic">manual</span>
                )}
                <span className="text-muted-foreground">{a.last_run_at ? relativeTime(a.last_run_at) : "never"}</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

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
                <TableHead className="text-right">Units (30d)</TableHead>
                <TableHead className="text-right">Units (all)</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Leads</TableHead>
                <TableHead className="text-right">Est. rate/unit</TableHead>
                <TableHead className="text-right">Est. cost (30d)</TableHead>
                <TableHead className="text-right">Est. cost (all)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiUsage.map((u) => (
                <TableRow key={u.rate.key}>
                  <TableCell className="font-medium">
                    {u.rate.label}
                    <span className="ml-2 text-[11px] lowercase tracking-wide text-muted-foreground">/ {u.rate.unitLabel}</span>
                    <span className="ml-2 text-[11px] uppercase tracking-wide text-muted-foreground">{u.rate.confidence}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{num(u.units30d)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(u.unitsAll)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{num(u.failedAll)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(u.leads)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(u.rate.usdPerUnit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(u.estCost30d)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(u.estCostAll)}</TableCell>
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
              Estimates only. This app counts activity it triggers (discovery calls fired by Agent 03, price-pull sessions
              opened by Agent 05) and what landed; true credit and browser-hour consumption and billing live in the remote
              agents and each provider account, not here. Rates are editable in <code>lib/api-cost-rates.ts</code>.
            </p>
            {apiUsage.map((u) => (
              <p key={u.rate.key}>
                <span className="font-medium text-foreground">{u.rate.label}:</span> {u.rate.assumption} (source: {u.rate.source})
              </p>
            ))}
            <p className="pt-1">
              <span className="font-medium text-foreground">Also in use (not per-call metered here):</span>{" "}
              {UNMETERED_SERVICES.map((s, i) => (
                <span key={s.label}>
                  {i > 0 && "; "}
                  {s.label} ({s.note})
                </span>
              ))}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
