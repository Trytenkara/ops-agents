import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { CasesList } from "@/components/cases-list";
import { CallsList } from "@/components/calls-list";
import { toCaseRow, toCallCaseRow, isCallCase } from "@/lib/org-cases";

// Renders one category of escalations: the open-case worklist plus a small
// "recently resolved" table. Rows are pre-filtered by the caller (email /
// supplier / quote), so this is category-agnostic.
export function CasesSection({
  openRows,
  resolvedRows,
  slug,
  emptyLabel = "No open cases.",
}: {
  openRows: any[];
  resolvedRows: any[];
  slug: string;
  emptyLabel?: string;
}) {
  // Calling escalations are a phone worklist and carry a full brief (number,
  // local calling window, thread history, the ask), which does not fit a table
  // row. They render as cards above the rest.
  const callRows = openRows.filter(isCallCase).map(toCallCaseRow);
  const caseRows = openRows.filter((c) => !isCallCase(c)).map(toCaseRow);

  return (
    <div className="space-y-6">
      <CallsList rows={callRows} />

      {caseRows.length === 0 ? (
        callRows.length === 0 && <p className="text-center text-muted-foreground py-8 text-sm">{emptyLabel}</p>
      ) : (
        <CasesList rows={caseRows} slug={slug} />
      )}

      {resolvedRows.length > 0 && (
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
              {resolvedRows.map((c: any) => {
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
