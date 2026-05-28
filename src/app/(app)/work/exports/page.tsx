import Link from "next/link";
import { getSession, hasAnyRole } from "@/lib/auth";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { getAssignedOrgIds } from "@/lib/org-access";

export const dynamic = "force-dynamic";

// Cross-org rollup of every CSV-bound approval in the last 30 days.
// Lead Operators and Admins use this when they need to re-download a CSV or
// see what's stuck waiting for Tenkara upload.
export default async function ExportsRollup() {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "monitor"])) redirect("/work");

  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const assigned = await getAssignedOrgIds(session);
  if (assigned && assigned.length === 0) redirect("/work");
  const admin = createAdminClient();
  let q = admin
    .from("pending_approvals")
    .select("id, org_id, type, status, requested_at, decided_at, payload, orgs(slug, name), agents(name)")
    .in("status", ["approved", "ready_for_export", "exported"])
    .gte("requested_at", since)
    .order("requested_at", { ascending: false })
    .limit(200);
  if (assigned) q = q.in("org_id", assigned);
  const { data: rows } = await q;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Exports — last 30 days</h1>
        <p className="text-sm text-muted-foreground mt-1">Every CSV-bound approval across all orgs. Re-download here if needed.</p>
      </div>

      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Agent-prepared after approval.</span>{" "}
        CSVs are assembled by Agent 11 (Lead Scanner CSV Push) once a human approves the underlying batch. Uploads to Tenkara prod remain manual.
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Org</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>When</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(rows ?? []).map((r: any) => {
            const subject = r.payload?.subject ?? r.payload?.name ?? r.payload?.supplier_name ?? r.payload?.material_name ?? "—";
            return (
              <TableRow key={r.id}>
                <TableCell><Link href={`/work/orgs/${r.orgs?.slug}`} className="hover:underline">{r.orgs?.name}</Link></TableCell>
                <TableCell>{r.type}</TableCell>
                <TableCell className="font-medium truncate max-w-[28ch]">{String(subject)}</TableCell>
                <TableCell><StatusBadge s={r.status} /></TableCell>
                <TableCell className="text-muted-foreground">{r.agents?.name ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{relativeTime(r.decided_at ?? r.requested_at)}</TableCell>
                <TableCell className="text-right">
                  <a href={`/api/exports/approvals?ids=${r.id}`} className="text-primary hover:underline text-sm">Download CSV →</a>
                </TableCell>
              </TableRow>
            );
          })}
          {(!rows || rows.length === 0) && (
            <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Nothing exported in the last 30 days.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({ s }: { s: string }) {
  if (s === "approved") return <Badge variant="success">Approved</Badge>;
  if (s === "ready_for_export") return <Badge variant="default">Downloaded</Badge>;
  if (s === "exported") return <Badge variant="secondary">Uploaded</Badge>;
  return <Badge variant="secondary">{s}</Badge>;
}
