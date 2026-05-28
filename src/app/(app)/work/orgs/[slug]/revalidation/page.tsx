import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { notFound } from "next/navigation";
import { OperatorChip } from "@/components/operator-chip";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { resolveSupplierNames, resolveMaterialNames, resolveQuoteRefs } from "@/lib/tenkara-names";
import { DraftSignals } from "@/components/draft-signals";

export const dynamic = "force-dynamic";

export default async function RevalidationPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, quote_id, status, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), agents(name)")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = drafts ?? [];
  let supplierNames = new Map<string, string>();
  let materialNames = new Map<string, string>();
  let quoteRefs = new Map<string, string>();
  try {
    [supplierNames, materialNames, quoteRefs] = await Promise.all([
      resolveSupplierNames(rows.map((d: any) => d.supplier_id).filter(Boolean)),
      resolveMaterialNames(rows.map((d: any) => d.material_id).filter(Boolean)),
      resolveQuoteRefs(rows.map((d: any) => d.quote_id).filter(Boolean)),
    ]);
  } catch {
    // Fall back to UUID prefixes if Tenkara is unreachable.
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="font-serif text-2xl">Revalidation</h2>
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
          {rows.map((d: any) => {
            const supplierName = d.supplier_id ? supplierNames.get(d.supplier_id) : null;
            const materialName = d.material_id ? materialNames.get(d.material_id) : null;
            const quoteRef = d.quote_id ? quoteRefs.get(d.quote_id) : null;
            return (
            <TableRow key={d.id}>
              <TableCell className="font-medium">
                <div className="flex flex-col gap-1">
                  <span>{d.subject ?? "(no subject)"}</span>
                  <DraftSignals metadata={d.metadata} />
                </div>
              </TableCell>
              <TableCell title={d.supplier_id ?? undefined}>
                {supplierName ?? (d.supplier_id ? <code className="text-xs text-muted-foreground">{d.supplier_id.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell title={d.material_id ?? undefined}>
                {materialName ?? (d.material_id ? <code className="text-xs text-muted-foreground">{d.material_id.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell title={d.quote_id ?? undefined}>
                {quoteRef ?? (d.quote_id ? <code className="text-xs text-muted-foreground">{d.quote_id.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell className="text-muted-foreground">{d.agents?.name ?? "—"}</TableCell>
              <TableCell><OperatorChip name={d.users?.display_name} email={d.users?.email} role={primaryRole(operatorRoles(d.users))} /></TableCell>
              <TableCell><StatusBadge status={d.status} /></TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.created_at)}</TableCell>
              <TableCell><Link href={`/work/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link></TableCell>
            </TableRow>
          );
          })}
          {rows.length === 0 && (
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
