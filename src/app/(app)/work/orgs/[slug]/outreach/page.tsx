import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { resolveSupplierNames, resolveMaterialNames } from "@/lib/tenkara-names";
import { DraftSignals } from "@/components/draft-signals";

export const dynamic = "force-dynamic";

export default async function OutreachPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  // Agent 04 writes draft_references with source_agent='agent-04-outreach' in metadata.
  // We filter for non-revalidation outreach by looking for outreach-style metadata.
  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, subject, supplier_id, material_id, status, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), agents(name, slug)")
    .eq("org_id", org.id)
    .neq("agents.slug", "agent-02-revalidation")
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = drafts ?? [];
  let supplierNames = new Map<string, string>();
  let materialNames = new Map<string, string>();
  try {
    [supplierNames, materialNames] = await Promise.all([
      resolveSupplierNames(rows.map((d: any) => d.supplier_id).filter(Boolean)),
      resolveMaterialNames(rows.map((d: any) => d.material_id).filter(Boolean)),
    ]);
  } catch {
    // Fall back to UUID prefixes if Tenkara is unreachable.
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-2xl">Outreach</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Outreach drafts staged by Agent 04 — initial RFQs for promoted leads. Review in Missive, then click Send.
        </p>
      </div>

      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Agent 04 (Outreach)</span>{" "}
        drafts a Missive email per promoted lead with the From field empty. A human picks the sender and clicks Send — no agent sends automatically.{" "}
        QA findings come from Agent 10 (lint pass); reply detections come from Agent 08.
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Subject</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Signals</TableHead>
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
            return (
              <TableRow key={d.id}>
                <TableCell className="font-medium">{d.subject ?? "(no subject)"}</TableCell>
                <TableCell title={d.supplier_id ?? undefined}>
                  {supplierName ?? (d.supplier_id ? <code className="text-xs text-muted-foreground">{d.supplier_id.slice(0, 8)}…</code> : "—")}
                </TableCell>
                <TableCell title={d.material_id ?? undefined}>
                  {materialName ?? (d.material_id ? <code className="text-xs text-muted-foreground">{d.material_id.slice(0, 8)}…</code> : "—")}
                </TableCell>
                <TableCell><DraftSignals metadata={d.metadata} /></TableCell>
                <TableCell><OperatorChip name={d.users?.display_name} email={d.users?.email} role={primaryRole(operatorRoles(d.users))} /></TableCell>
                <TableCell><StatusBadge status={d.status} /></TableCell>
                <TableCell className="text-muted-foreground">{relativeTime(d.created_at)}</TableCell>
                <TableCell><Link href={`/work/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link></TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && (
            <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No outreach drafts yet. Promote an enriched lead on Leads in Flight to stage one.</TableCell></TableRow>
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
