"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { CaseResolve } from "@/components/case-resolve";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { useListFilter, byString, byNumberDesc, byDateDesc } from "@/components/use-list-filter";

export type CaseRow = {
  id: string;
  supplierId: string | null;
  supplierName: string | null;
  recommendedAction: string | null;
  staleDays: number | null;
  assignedName: string | null;
  assignedEmail: string | null;
  assignedRole: string | null;
  createdAt: string | null;
  formType: string | null;     // present for supplier_form cases
  formAvailable: boolean;      // true when a downloadable file is stored
};

const FORM_TYPE_LABEL: Record<string, string> = {
  credit_reference: "Credit reference",
  new_account: "New account",
  w9_tax: "W-9 / tax",
  nda: "NDA",
  banking: "Banking",
  other: "Form",
};

export function CasesList({ rows, slug }: { rows: CaseRow[]; slug: string }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.supplierName ?? ""} ${r.recommendedAction ?? ""} ${r.assignedName ?? ""}`,
    searchPlaceholder: "supplier, action, operator…",
    sorts: [
      { value: "stale", label: "Most stale", compare: byNumberDesc((r: CaseRow) => r.staleDays) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: CaseRow) => r.supplierName) },
      { value: "newest", label: "Newest", compare: byDateDesc((r: CaseRow) => r.createdAt) },
    ],
    defaultSort: "stale",
  });

  const csvRows = filtered.map((r) => [
    r.supplierName ?? r.supplierId ?? "",
    r.recommendedAction ?? "",
    r.staleDays ?? "",
    r.assignedName ?? r.assignedEmail ?? "",
    r.createdAt ?? "",
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "cases")}
          headers={["Supplier", "Recommended action", "Stale (days)", "Assigned", "Opened"]}
          rows={csvRows}
        />
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
          {filtered.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-medium" title={c.supplierId ?? undefined}>
                {c.supplierName ?? (c.supplierId ? <code className="text-xs">{c.supplierId.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell className="max-w-md">
                {c.formType && (
                  <span className="mr-2 inline-block rounded-full bg-secondary px-2 py-0.5 text-xs align-middle">
                    {FORM_TYPE_LABEL[c.formType] ?? FORM_TYPE_LABEL.other}
                  </span>
                )}
                {c.recommendedAction ?? "—"}
                {c.formAvailable && (
                  <a
                    href={`/api/cases/${c.id}/form`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 inline-block text-xs font-medium text-primary underline hover:no-underline"
                  >
                    Download form ↓
                  </a>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">{c.staleDays != null ? `${c.staleDays}d` : "—"}</TableCell>
              <TableCell>
                <OperatorChip name={c.assignedName} email={c.assignedEmail} role={c.assignedRole} />
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">{relativeTime(c.createdAt)}</TableCell>
              <TableCell className="text-right"><CaseResolve caseId={c.id} /></TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No open cases match.</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
