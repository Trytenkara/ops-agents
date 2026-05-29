import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getAssignedOrgIds } from "@/lib/org-access";
import { DraftSignals } from "@/components/draft-signals";

export const dynamic = "force-dynamic";

export default async function CrossOrgPage() {
  const session = (await getSession())!;
  const assigned = await getAssignedOrgIds(session);
  // Account-managers-only land here with assigned=[] when they have no orgs.
  // Either way, narrow the query before hitting the admin client.
  if (assigned && assigned.length === 0) redirect("/work");

  const admin = createAdminClient();
  let q = admin
    .from("draft_references")
    .select("id, subject, status, created_at, org_id, metadata, orgs(slug, name)")
    .eq("status", "staged")
    .order("created_at", { ascending: false })
    .limit(50);
  if (assigned) q = q.in("org_id", assigned);
  const { data: drafts } = await q;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">All staged drafts</h1>
        <p className="text-sm text-muted-foreground mt-1">Cross-org rollup. Lead Operators view.</p>
      </div>

      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Agent-staged, human-sent.</span>{" "}
        Drafts here are written by Agent 02 (Quote Revalidation). A human picks one up, edits it in Missive, and sends — no agent ever sends email automatically.
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Subject</TableHead>
            <TableHead>Org</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Staged</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(drafts ?? []).map((d: any) => (
            <TableRow key={d.id}>
              <TableCell className="font-medium">
                <div className="flex flex-col gap-1">
                  <span>{d.subject ?? "(no subject)"}</span>
                  <DraftSignals metadata={d.metadata} />
                </div>
              </TableCell>
              <TableCell>{d.orgs?.name ?? "—"}</TableCell>
              <TableCell><Badge variant="warn">{d.status}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.created_at)}</TableCell>
              <TableCell><Link href={`/work/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link></TableCell>
            </TableRow>
          ))}
          {(!drafts || drafts.length === 0) && (
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No staged drafts.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
