import { redirect } from "next/navigation";
import { getSession, canSeeAgentTab, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { compareAgentsBySlug } from "@/lib/agents-sort";
import { HaltAllAgents } from "@/components/halt-all-agents";
import { RetriggerExportButton } from "@/components/retrigger-export-button";

export const dynamic = "force-dynamic";

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
  const { data: leadExports } = await admin
    .from("lead_scanner_exports")
    .select("id, supplier_name, supplier_id, status, generated_at, slack_message_ts, error, generated_by_agent, agents:agents!lead_scanner_exports_generated_by_agent_fkey(name)")
    .order("generated_at", { ascending: false })
    .limit(100);

  const checks = [
    { name: "Supabase (OA DB)", ok: true, note: "connected (this page loaded)" },
    { name: "Slack bot token", ok: !!process.env.SLACK_BOT_TOKEN, note: process.env.SLACK_BOT_TOKEN ? "configured" : "missing" },
    { name: "Slack escalation channel", ok: !!process.env.SLACK_ESCALATION_CHANNEL_ID, note: process.env.SLACK_ESCALATION_CHANNEL_ID ?? "unset" },
    { name: "Service role key", ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY, note: process.env.SUPABASE_SERVICE_ROLE_KEY ? "configured" : "missing" },
  ];

  const failedCount = (leadExports ?? []).filter((e: any) => e.status === "failed").length;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">System health</h1>
        <p className="text-sm text-muted-foreground mt-1">Connector status, last-run heartbeats, and the Lead Scanner handoff to Andrew.</p>
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
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">
              Lead Scanner exports{" "}
              <span className="ml-1 text-foreground">· {leadExports?.length ?? 0}</span>
              {failedCount > 0 && <Badge variant="danger" className="ml-2">{failedCount} failed</Badge>}
            </CardTitle>
            {isAdmin && <RetriggerExportButton />}
          </div>
        </CardHeader>
        <CardContent>
          {(leadExports ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No exports yet. Agents send CSVs to Andrew via <code className="text-xs">/api/agent/lead-exports</code>.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Generated</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(leadExports as any[]).map((e) => (
                  <TableRow key={e.id} className={e.status === "failed" ? "bg-destructive/5" : undefined}>
                    <TableCell className="font-medium">{e.supplier_name ?? e.supplier_id ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{e.agents?.name ?? "—"}</TableCell>
                    <TableCell><ExportStatus s={e.status} /></TableCell>
                    <TableCell className="text-muted-foreground">{relativeTime(e.generated_at)}</TableCell>
                    <TableCell className="text-right text-xs">
                      {e.slack_message_ts && (
                        <span className="text-muted-foreground font-mono">{e.slack_message_ts.slice(0, 14)}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ExportStatus({ s }: { s: string }) {
  if (s === "queued") return <Badge variant="secondary">Queued</Badge>;
  if (s === "sent") return <Badge variant="warn">Sent to Andrew</Badge>;
  if (s === "acknowledged_by_andrew") return <Badge variant="default">✓ Ack'd</Badge>;
  if (s === "uploaded") return <Badge variant="success">Uploaded</Badge>;
  if (s === "failed") return <Badge variant="danger">Failed (&gt;72h)</Badge>;
  return <Badge variant="secondary">{s}</Badge>;
}
