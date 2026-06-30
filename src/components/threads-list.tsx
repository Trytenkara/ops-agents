"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { OperatorChip } from "@/components/operator-chip";
import { DraftSignals } from "@/components/draft-signals";
import { DraftStatusBadge } from "@/components/draft-status-badge";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { useListFilter, byString, byDateDesc } from "@/components/use-list-filter";

export type ThreadKind = "outbound" | "inbound";

export type ThreadRow = {
  id: string;
  kind: ThreadKind;
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
  reviewerName: string | null;
};

const KIND_META: Record<ThreadKind, { label: string; variant: string; title: string }> = {
  outbound: { label: "Outbound RFQ", variant: "default", title: "Initial outreach email to a supplier." },
  inbound: { label: "Inbound reply", variant: "success", title: "A reply drafted for a supplier's incoming email." },
};


const FILTERS: { value: "all" | ThreadKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "outbound", label: "Outbound RFQs" },
  { value: "inbound", label: "Inbound replies" },
];

export function ThreadsList({ rows, slug }: { rows: ThreadRow[]; slug: string }) {
  const [kind, setKind] = useState<"all" | ThreadKind>("all");

  const byKind = useMemo(() => (kind === "all" ? rows : rows.filter((r) => r.kind === kind)), [kind, rows]);
  const counts = useMemo(() => {
    const c = { all: rows.length, outbound: 0, inbound: 0 } as Record<string, number>;
    for (const r of rows) c[r.kind]++;
    return c;
  }, [rows]);

  const { filtered, controls } = useListFilter(byKind, {
    searchText: (r) => `${r.subject ?? ""} ${r.supplierName ?? ""} ${r.materialName ?? ""}`,
    searchPlaceholder: "subject, supplier, material…",
    sorts: [
      { value: "newest", label: "Newest", compare: byDateDesc((r: ThreadRow) => r.createdAt) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: ThreadRow) => r.supplierName) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: ThreadRow) => r.materialName) },
      { value: "status", label: "Status", compare: byString((r: ThreadRow) => r.status) },
    ],
    defaultSort: "newest",
  });

  const csvRows = filtered.map((r) => [
    KIND_META[r.kind].label,
    r.subject ?? "",
    r.supplierName ?? r.supplierId ?? "",
    r.materialName ?? r.materialId ?? "",
    r.status,
    r.assignedName ?? r.assignedEmail ?? "",
    r.createdAt ?? "",
  ]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setKind(f.value)}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
              (kind === f.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")
            }
          >
            {f.label} <span className="tabular-nums opacity-70">{counts[f.value]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "threads")}
          headers={["Kind", "Subject", "Supplier", "Material", "Status", "Assigned", "Staged"]}
          rows={csvRows}
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Assigned</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Staged</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((d) => (
            <TableRow key={d.id}>
              <TableCell>
                <Badge variant={KIND_META[d.kind].variant as any} title={KIND_META[d.kind].title}>
                  {KIND_META[d.kind].label}
                </Badge>
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex flex-col gap-1">
                  <span>{d.subject ?? "(no subject)"}</span>
                  <DraftSignals metadata={d.metadata} />
                  {d.quoteRef && <span className="text-xs text-muted-foreground">quote {d.quoteRef}</span>}
                </div>
              </TableCell>
              <TableCell title={d.supplierId ?? undefined}>
                {d.supplierName ?? (d.supplierId ? <span className="text-xs text-muted-foreground">name unavailable</span> : "—")}
              </TableCell>
              <TableCell title={d.materialId ?? undefined}>
                {d.materialName ?? (d.materialId ? <span className="text-xs text-muted-foreground">name unavailable</span> : "—")}
              </TableCell>
              <TableCell><OperatorChip name={d.assignedName} email={d.assignedEmail} role={d.assignedRole} /></TableCell>
              <TableCell><DraftStatusBadge status={d.status} reviewerName={d.reviewerName} /></TableCell>
              <TableCell className="text-muted-foreground">{relativeTime(d.createdAt)}</TableCell>
              <TableCell><Link href={`/work/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link></TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                No threads match.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
