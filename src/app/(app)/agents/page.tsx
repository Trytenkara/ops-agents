import { redirect } from "next/navigation";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AgentActivityPage() {
  const session = (await getSession())!;
  if (!canSeeAgentTab(session)) redirect("/");

  const admin = createAdminClient();
  const { data: runs } = await admin
    .from("agent_runs")
    .select("id, agent_id, org_id, run_started_at, run_finished_at, status, summary, items_processed, agents(name, slug), orgs(slug, name)")
    .order("run_started_at", { ascending: false })
    .limit(100);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Agent activity</h1>
        <p className="text-sm text-muted-foreground">Every run, every agent. Last 100.</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Org</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Summary</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(runs ?? []).map((r: any) => {
            const dur = r.run_finished_at ? Math.round((new Date(r.run_finished_at).getTime() - new Date(r.run_started_at).getTime()) / 1000) : null;
            return (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.agents?.name ?? r.agent_id}</TableCell>
                <TableCell>{r.orgs?.name ?? "—"}</TableCell>
                <TableCell><RunStatus s={r.status} /></TableCell>
                <TableCell className="text-muted-foreground truncate max-w-[40ch]">{r.summary ?? "—"}</TableCell>
                <TableCell>{r.items_processed ?? 0}</TableCell>
                <TableCell className="text-muted-foreground">{relativeTime(r.run_started_at)}</TableCell>
                <TableCell className="text-muted-foreground">{dur != null ? `${dur}s` : "—"}</TableCell>
              </TableRow>
            );
          })}
          {(!runs || runs.length === 0) && (
            <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No runs yet. Agents post here via POST /api/runs.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function RunStatus({ s }: { s: string }) {
  const v = s === "success" ? "success" : s === "running" ? "secondary" : s === "partial" ? "warn" : "danger";
  return <Badge variant={v as any}>{s}</Badge>;
}
