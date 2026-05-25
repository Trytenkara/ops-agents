import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function CrossOrgPage() {
  const admin = createAdminClient();
  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, subject, status, created_at, orgs(slug, name)")
    .eq("status", "staged")
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">All staged drafts</h1>
        <p className="text-sm text-muted-foreground">Cross-org rollup. Ops leads view.</p>
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
              <TableCell className="font-medium">{d.subject ?? "(no subject)"}</TableCell>
              <TableCell>{d.orgs?.name ?? "—"}</TableCell>
              <TableCell><Badge variant="warn">{d.status}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.created_at)}</TableCell>
              <TableCell><Link href={`/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link></TableCell>
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
