import Link from "next/link";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function TodayInboxPage() {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const isAccountManager = hasAnyRole(session, ["account_manager"]) && !hasAnyRole(session, ["admin","ops_lead","ops_operator"]);

  // My assigned drafts (Phase 1: drafts are the primary actionable item).
  const { data: assignedDrafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, status, created_at, org_id, orgs(slug, name)")
    .eq("assigned_operator", session.userId)
    .eq("status", "staged")
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: unassignedDrafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, status, created_at, org_id, orgs(slug, name)")
    .is("assigned_operator", null)
    .eq("status", "staged")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: recentFailures } = await admin
    .from("agent_runs")
    .select("id, agent_id, status, summary, run_started_at, agents(name, slug)")
    .eq("status", "failure")
    .order("run_started_at", { ascending: false })
    .limit(5);

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="text-sm text-muted-foreground">
          {isAccountManager
            ? "Client-facing items needing your attention."
            : "Drafts, cases, and escalations that need a human."}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">My assigned items <Badge variant="secondary" className="ml-2">{assignedDrafts?.length ?? 0}</Badge></CardTitle>
        </CardHeader>
        <CardContent>
          {assignedDrafts && assignedDrafts.length > 0 ? (
            <DraftTable rows={assignedDrafts as any} />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing assigned. Take a look at unassigned items below.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unassigned <Badge variant="secondary" className="ml-2">{unassignedDrafts?.length ?? 0}</Badge></CardTitle>
        </CardHeader>
        <CardContent>
          {unassignedDrafts && unassignedDrafts.length > 0 ? (
            <DraftTable rows={unassignedDrafts as any} />
          ) : (
            <p className="text-sm text-muted-foreground">Inbox zero — nothing waiting for pickup.</p>
          )}
        </CardContent>
      </Card>

      {hasAnyRole(session, ["admin","monitor"]) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent agent failures</CardTitle>
          </CardHeader>
          <CardContent>
            {recentFailures && recentFailures.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentFailures.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell><Link href={`/agents?run=${r.id}`} className="hover:underline">{r.agents?.name ?? r.agent_id}</Link></TableCell>
                      <TableCell className="text-muted-foreground truncate max-w-[40ch]">{r.summary ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{relativeTime(r.run_started_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No recent failures.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DraftTable({ rows }: { rows: any[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Org</TableHead>
          <TableHead>Supplier</TableHead>
          <TableHead>Material</TableHead>
          <TableHead>Staged</TableHead>
          <TableHead></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => (
          <TableRow key={d.id}>
            <TableCell className="font-medium">{d.subject ?? "(no subject)"}</TableCell>
            <TableCell>{d.orgs?.name ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{d.supplier_id ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{d.material_id ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{relativeTime(d.created_at)}</TableCell>
            <TableCell><Link href={`/drafts/${d.id}`} className="text-primary hover:underline text-sm">Review →</Link></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
