"use client";

import Link from "next/link";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { DraftSignals } from "@/components/draft-signals";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { useListFilter, byString, byDateDesc } from "@/components/use-list-filter";

export type RequoteRow = {
  id: string;
  subject: string | null;
  supplierId: string | null;
  supplierName: string | null;
  materialId: string | null;
  materialName: string | null;
  quoteRef: string | null;
  status: string;
  createdAt: string | null;
  metadata: any;
  assignedName: string | null;
  assignedEmail: string | null;
  assignedRole: string | null;
};

function StatusBadge({ status }: { status: string }) {
  const v = status === "staged" ? "warn" : status === "reviewed" ? "success" : status === "sent" ? "default" : "secondary";
  return <Badge variant={v as any}>{status}</Badge>;
}

// Direct-supplier re-quote drafts (Agent 02). For non-marketplace suppliers we
// can't read a public price, so an expiring quote becomes a draft email asking
// for a fresh quote — reviewed and sent like any other draft.
export function RequoteList({ rows, slug }: { rows: RequoteRow[]; slug: string }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.subject ?? ""} ${r.supplierName ?? ""} ${r.materialName ?? ""}`,
    searchPlaceholder: "subject, supplier, material…",
    sorts: [
      { value: "newest", label: "Newest", compare: byDateDesc((r: RequoteRow) => r.createdAt) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: RequoteRow) => r.supplierName) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: RequoteRow) => r.materialName) },
      { value: "status", label: "Status", compare: byString((r: RequoteRow) => r.status) },
    ],
    defaultSort: "newest",
  });

  const csvRows = filtered.map((r) => [
    r.subject ?? "",
    r.supplierName ?? r.supplierId ?? "",
    r.materialName ?? r.materialId ?? "",
    r.quoteRef ?? "",
    r.status,
    r.createdAt ?? "",
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "requotes")}
          headers={["Subject", "Supplier", "Material", "Quote", "Status", "Staged"]}
          rows={csvRows}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Subject</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Quote</TableHead>
            <TableHead>Assigned</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Staged</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="font-medium">
                <div className="flex flex-col gap-1">
                  <span>{d.subject ?? "(no subject)"}</span>
                  <DraftSignals metadata={d.metadata} />
                </div>
              </TableCell>
              <TableCell title={d.supplierId ?? undefined}>
                {d.supplierName ?? (d.supplierId ? <span className="text-xs text-muted-foreground">name unavailable</span> : "—")}
              </TableCell>
              <TableCell title={d.materialId ?? undefined}>
                {d.materialName ?? (d.materialId ? <span className="text-xs text-muted-foreground">name unavailable</span> : "—")}
              </TableCell>
              <TableCell className="text-muted-foreground">{d.quoteRef ?? "—"}</TableCell>
              <TableCell><OperatorChip name={d.assignedName} email={d.assignedEmail} role={d.assignedRole} /></TableCell>
              <TableCell><StatusBadge status={d.status} /></TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.createdAt)}</TableCell>
              <TableCell><Link href={`/work/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link></TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground py-8">No re-quote drafts.</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
