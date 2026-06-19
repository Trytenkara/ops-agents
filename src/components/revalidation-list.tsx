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

export type RevalidationRow = {
  id: string;
  subject: string | null;
  supplierId: string | null;
  supplierName: string | null;
  materialId: string | null;
  materialName: string | null;
  quoteId: string | null;
  quoteRef: string | null;
  agentName: string | null;
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

export function RevalidationList({ rows, slug }: { rows: RevalidationRow[]; slug: string }) {
  const { filtered, controls } = useListFilter(rows, {
    searchText: (r) => `${r.subject ?? ""} ${r.supplierName ?? ""} ${r.materialName ?? ""} ${r.quoteRef ?? ""}`,
    searchPlaceholder: "subject, supplier, material, quote…",
    sorts: [
      { value: "newest", label: "Newest", compare: byDateDesc((r: RevalidationRow) => r.createdAt) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: RevalidationRow) => r.supplierName) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: RevalidationRow) => r.materialName) },
      { value: "status", label: "Status", compare: byString((r: RevalidationRow) => r.status) },
    ],
    defaultSort: "newest",
  });

  const csvRows = filtered.map((r) => [
    r.subject ?? "",
    r.supplierName ?? r.supplierId ?? "",
    r.materialName ?? r.materialId ?? "",
    r.quoteRef ?? r.quoteId ?? "",
    r.agentName ?? "",
    r.status,
    r.createdAt ?? "",
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "revalidation")}
          headers={["Subject", "Supplier", "Material", "Quote", "Agent", "Status", "Staged"]}
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
            <TableHead>Agent</TableHead>
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
                {d.supplierName ?? (d.supplierId ? <code className="text-xs text-muted-foreground">{d.supplierId.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell title={d.materialId ?? undefined}>
                {d.materialName ?? (d.materialId ? <code className="text-xs text-muted-foreground">{d.materialId.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell title={d.quoteId ?? undefined}>
                {d.quoteRef ?? (d.quoteId ? <code className="text-xs text-muted-foreground">{d.quoteId.slice(0, 8)}…</code> : "—")}
              </TableCell>
              <TableCell className="text-muted-foreground">{d.agentName ?? "—"}</TableCell>
              <TableCell><OperatorChip name={d.assignedName} email={d.assignedEmail} role={d.assignedRole} /></TableCell>
              <TableCell><StatusBadge status={d.status} /></TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.createdAt)}</TableCell>
              <TableCell><Link href={`/work/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link></TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No revalidation drafts match.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
