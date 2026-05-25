import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RevalidationPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, quote_id, status, created_at, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email), agents(name)")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold">Revalidation</h2>
          <p className="text-sm text-muted-foreground">Quotes expiring or recently expired. Agent 02 surfaces drafts here.</p>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Subject</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Quote</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Assigned</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Staged</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(drafts ?? []).map((d: any) => (
            <TableRow key={d.id}>
              <TableCell className="font-medium">{d.subject ?? "(no subject)"}</TableCell>
              <TableCell className="text-muted-foreground">{d.supplier_id ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{d.material_id ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{d.quote_id ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{d.agents?.name ?? "—"}</TableCell>
              <TableCell className="text-muted-foreground">{d.users?.display_name ?? d.users?.email ?? "—"}</TableCell>
              <TableCell><StatusBadge status={d.status} /></TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.created_at)}</TableCell>
              <TableCell><Link href={`/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link></TableCell>
            </TableRow>
          ))}
          {(!drafts || drafts.length === 0) && (
            <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No revalidation drafts yet. Agent 02 will populate this.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const v = status === "staged" ? "warn" : status === "reviewed" ? "success" : status === "sent" ? "default" : "secondary";
  return <Badge variant={v as any}>{status}</Badge>;
}
