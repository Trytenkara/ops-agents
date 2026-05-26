import { redirect } from "next/navigation";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { operatorRoles, primaryRole } from "@/lib/operator";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AgentActivityPage() {
  const session = (await getSession())!;
  if (!canSeeAgentTab(session)) redirect("/");

  const admin = createAdminClient();
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // Pull runs, lead-scanner exports, and CSV-download audit entries in parallel.
  const [runsRes, leadExportsRes, csvDownloadsRes, leadCountRes] = await Promise.all([
    admin
      .from("agent_runs")
      .select("id, agent_id, org_id, run_started_at, run_finished_at, status, summary, items_processed, agents(name, slug, description), orgs(slug, name)")
      .order("run_started_at", { ascending: false })
      .limit(60),
    admin
      .from("lead_scanner_exports")
      .select("id, supplier_name, status, generated_at, slack_message_ts, agents:agents!lead_scanner_exports_generated_by_agent_fkey(name, slug, description)")
      .order("generated_at", { ascending: false })
      .limit(40),
    admin
      .from("audit_log")
      .select("id, action, target_id, at, target_table, actor_user_id, users:users!audit_log_actor_user_id_fkey(display_name, email, user_roles(role))")
      .in("action", ["approval.exported_pending_upload", "approval.exported_confirmed"])
      .order("at", { ascending: false })
      .limit(40),
    admin
      .from("lead_scanner_exports")
      .select("id", { count: "exact", head: true })
      .gte("generated_at", since24h),
  ]);

  // Merge runs + lead exports + CSV download audit entries into a unified stream.
  type Event =
    | { kind: "run"; ts: string; row: any }
    | { kind: "lead_export"; ts: string; row: any }
    | { kind: "csv_download"; ts: string; row: any };

  const events: Event[] = [
    ...((runsRes.data ?? []) as any[]).map((r) => ({ kind: "run" as const, ts: r.run_started_at, row: r })),
    ...((leadExportsRes.data ?? []) as any[]).map((r) => ({ kind: "lead_export" as const, ts: r.generated_at, row: r })),
    ...((csvDownloadsRes.data ?? []) as any[]).map((r) => ({ kind: "csv_download" as const, ts: r.at, row: r })),
  ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 100);

  const leadExportsLast24h = leadCountRes.count ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="font-serif text-3xl tracking-tight">Agent activity</h1>
          <p className="text-sm text-muted-foreground mt-1">Every run, every CSV export, every human review. Last 100 events.</p>
        </div>
        <div className="text-sm">
          <Link href="/agents/health" className="text-muted-foreground hover:underline">
            {leadExportsLast24h} CSV{leadExportsLast24h === 1 ? "" : "s"} to Andrew in last 24h →
          </Link>
        </div>
      </div>

      <Card className="tb-surface shadow-none">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Org / Target</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => <EventRow key={`${e.kind}-${e.row.id}`} event={e} />)}
              {events.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No events yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function EventRow({ event }: { event: any }) {
  if (event.kind === "run") {
    const r = event.row;
    const dur = r.run_finished_at
      ? Math.round((new Date(r.run_finished_at).getTime() - new Date(r.run_started_at).getTime()) / 1000)
      : null;
    return (
      <TableRow>
        <TableCell><EventIcon kind="run" /></TableCell>
        <TableCell><Badge variant={runStatusVariant(r.status)}>{r.status}</Badge></TableCell>
        <TableCell className="font-medium" title={r.agents?.description ?? undefined}>{r.agents?.name ?? "—"}</TableCell>
        <TableCell>{r.orgs?.name ?? "—"}</TableCell>
        <TableCell className="text-muted-foreground truncate max-w-[40ch]">
          {r.summary ?? `${r.items_processed ?? 0} items${dur != null ? ` · ${dur}s` : ""}`}
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">{relativeTime(r.run_started_at)}</TableCell>
      </TableRow>
    );
  }
  if (event.kind === "lead_export") {
    const r = event.row;
    return (
      <TableRow>
        <TableCell><EventIcon kind="lead_export" /></TableCell>
        <TableCell><Badge variant="default">CSV → Andrew</Badge></TableCell>
        <TableCell className="font-medium" title={r.agents?.description ?? undefined}>{r.agents?.name ?? "—"}</TableCell>
        <TableCell>{r.supplier_name ?? "—"}</TableCell>
        <TableCell className="text-muted-foreground text-xs">
          status: {r.status}
          {r.slack_message_ts && <> · <span className="font-mono">{r.slack_message_ts.slice(0, 14)}</span></>}
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">{relativeTime(r.generated_at)}</TableCell>
      </TableRow>
    );
  }
  if (event.kind === "csv_download") {
    const r = event.row;
    const action = r.action === "approval.exported_pending_upload" ? "CSV downloaded" : "Marked uploaded";
    return (
      <TableRow>
        <TableCell><EventIcon kind="csv_download" /></TableCell>
        <TableCell><Badge variant="secondary">{action}</Badge></TableCell>
        <TableCell>
          <OperatorChip
            name={r.users?.display_name}
            email={r.users?.email}
            role={primaryRole(operatorRoles(r.users))}
          />
        </TableCell>
        <TableCell className="text-muted-foreground text-xs font-mono">{r.target_id?.slice(0, 8)}…</TableCell>
        <TableCell className="text-muted-foreground text-xs">{r.target_table}</TableCell>
        <TableCell className="text-muted-foreground text-xs">{relativeTime(r.at)}</TableCell>
      </TableRow>
    );
  }
  return null;
}

function EventIcon({ kind }: { kind: "run" | "lead_export" | "csv_download" }) {
  if (kind === "run") return <span className="text-xs" title="Agent run">⚙</span>;
  if (kind === "lead_export") return <span className="text-xs" title="CSV → Andrew">↗</span>;
  return <span className="text-xs" title="Human CSV action">⬇</span>;
}

function runStatusVariant(s: string): any {
  if (s === "success") return "success";
  if (s === "running") return "secondary";
  if (s === "partial") return "warn";
  return "danger";
}
