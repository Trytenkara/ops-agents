import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { ListPageHeader } from "@/components/list-page-header";
import { CallsList } from "@/components/calls-list";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { loadOrgCases, toCallCaseRow, loadInboxContext } from "@/lib/org-cases";

export const dynamic = "force-dynamic";

// The phone worklist for one client. Calls are scheduled work in the cadence
// (day 1 intro, day 5 on silence), not a last resort, so they get their own tab
// rather than sitting inside the email escalations list where they used to.
export default async function CallsPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const [{ openRows, resolvedRows, resolvedTotal }, inbox] = await Promise.all([
    loadOrgCases(admin, org.id, undefined, ["call"]),
    loadInboxContext(admin, org.id),
  ]);
  const open = openRows.map((c: any) => toCallCaseRow(c, inbox));
  const done = resolvedRows;

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Call Tracker"
        description="Every call this client's suppliers are owed. Filter to one operator to get their list, then open a row for the number, the calling window, where the email thread stands, and what to ask for. Log the outcome here so the email sequence knows whether to resume."
        collectedBy="Agent 15"
      />

      {open.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No calls are due right now.</p>}
      <CallsList rows={open} orgId={org.id} />

      {done.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recently closed
            {resolvedTotal > done.length && (
              <span className="ml-2 font-normal normal-case tracking-normal">
                newest {done.length} of {resolvedTotal}
              </span>
            )}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {done.map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {(c.metadata?.supplier_name as string | undefined) ?? c.supplier_id ?? "-"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{relativeTime(c.resolved_at)}</TableCell>
                  <TableCell className="text-muted-foreground">{c.users?.display_name ?? c.users?.email ?? "-"}</TableCell>
                  <TableCell className="text-muted-foreground">{c.resolution_note ?? "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
