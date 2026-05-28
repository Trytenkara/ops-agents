import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { CaseResolve } from "@/components/case-resolve";

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
      <div>
        <h2 className="font-serif text-2xl">Cases</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Stale leads escalated by Agent 07 — supplier outreach that's been active &gt;14d. Pick a case, take the recommended action in Missive or off-platform, and resolve.
        </p>
      </div>

      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Agent 07 (Escalation)</span> opens these when an in-flight lead crosses 14 days without resolution. The assigned operator is the org's primary (or backup if OOO).
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Supplier</TableHead>
            <TableHead>Recommended action</TableHead>
            <TableHead>Stale</TableHead>
            <TableHead>Assigned</TableHead>
            <TableHead>Opened</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(openCases ?? []).map((c: any) => {
            const supplierName = c.metadata?.supplier_name as string | undefined;
            const staleDays = c.metadata?.stale_days as number | undefined;
            return (
              <TableRow key={c.id}>
                <TableCell className="font-medium" title={c.supplier_id ?? undefined}>
                  {supplierName ?? (c.supplier_id ? <code className="text-xs">{c.supplier_id.slice(0, 8)}…</code> : "—")}
                </TableCell>
                <TableCell className="max-w-md">{c.recommended_action ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {staleDays != null ? `${staleDays}d` : "—"}
                </TableCell>
                <TableCell>
                  <OperatorChip name={c.users?.display_name} email={c.users?.email} role={primaryRole(operatorRoles(c.users))} />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">{relativeTime(c.created_at)}</TableCell>
                <TableCell className="text-right"><CaseResolve caseId={c.id} /></TableCell>
              </TableRow>
            );
          })}
          {(!openCases || openCases.length === 0) && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No open cases.</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

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
