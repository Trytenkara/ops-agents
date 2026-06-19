import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { ListPageHeader } from "@/components/list-page-header";
import { CasesList, type CaseRow } from "@/components/cases-list";

export const dynamic = "force-dynamic";

export default async function CasesPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: openCases } = await admin
    .from("cases")
    .select("id, supplier_id, type, recommended_action, status, created_at, resolved_at, resolution_note, metadata, assigned_operator, users:users!cases_assigned_operator_fkey(display_name, email, user_roles(role))")
    .eq("org_id", org.id)
    .in("status", ["open", "in_progress"])
    .order("created_at", { ascending: false });

  const { data: resolvedRecent } = await admin
    .from("cases")
    .select("id, supplier_id, type, recommended_action, status, resolved_at, resolution_note, metadata, users:users!cases_assigned_operator_fkey(display_name, email)")
    .eq("org_id", org.id)
    .eq("status", "resolved")
    .order("resolved_at", { ascending: false })
    .limit(20);

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Cases"
        description="Stale leads escalated by Agent 07 — supplier outreach that's been active >14d. Pick a case, take the recommended action in Missive or off-platform, and resolve."
        explainer={
          <>
            <span className="font-medium text-foreground">Agent 07 (Escalation)</span> opens these when an in-flight lead crosses 14 days without resolution. The assigned operator is the org&apos;s primary (or backup if OOO).
          </>
        }
      />

      {(() => {
        const caseRows: CaseRow[] = (openCases ?? []).map((c: any) => ({
          id: c.id,
          supplierId: c.supplier_id ?? null,
          supplierName: (c.metadata?.supplier_name as string | undefined) ?? null,
          recommendedAction: c.recommended_action ?? null,
          staleDays: (c.metadata?.stale_days as number | undefined) ?? null,
          assignedName: c.users?.display_name ?? null,
          assignedEmail: c.users?.email ?? null,
          assignedRole: primaryRole(operatorRoles(c.users)),
          createdAt: c.created_at ?? null,
        }));
        return caseRows.length === 0 ? (
          <p className="text-center text-muted-foreground py-8 text-sm">No open cases.</p>
        ) : (
          <CasesList rows={caseRows} slug={params.slug} />
        );
      })()}

      {resolvedRecent && resolvedRecent.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Recently resolved</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Resolved</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(resolvedRecent as any[]).map((c) => {
                const supplierName = c.metadata?.supplier_name as string | undefined;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium" title={c.supplier_id ?? undefined}>
                      {supplierName ?? (c.supplier_id ? <code className="text-xs">{c.supplier_id.slice(0, 8)}…</code> : "—")}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{relativeTime(c.resolved_at)}</TableCell>
                    <TableCell className="text-muted-foreground">{c.users?.display_name ?? c.users?.email ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{c.resolution_note ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
