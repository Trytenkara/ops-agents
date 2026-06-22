"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { SUPPLIER_TEMPLATE_HEADERS } from "@/lib/tenkara-templates";
import { useListFilter, byString } from "@/components/use-list-filter";
import { useState } from "react";
import type { ClientSuppliers, ClientSupplier, SupplierApproval } from "@/lib/client-suppliers";

const STATUS_META: Record<SupplierApproval, { label: string; variant: "success" | "warn" | "secondary" }> = {
  approved: { label: "Approved", variant: "success" },
  pending_review: { label: "Pending", variant: "warn" },
  denied: { label: "Denied", variant: "secondary" },
  draft: { label: "Draft", variant: "secondary" },
};
const STATUS_ORDER: Record<SupplierApproval, number> = { approved: 0, pending_review: 1, denied: 2, draft: 3 };

const FILTER_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "approved", label: "Approved" },
  { value: "pending_review", label: "Pending" },
  { value: "denied", label: "Denied" },
  { value: "draft", label: "Draft" },
];

function StatusBadge({ s }: { s: SupplierApproval }) {
  const m = STATUS_META[s] ?? STATUS_META.draft;
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

export function ClientSuppliersSection({ suppliers, slug }: { suppliers: ClientSuppliers; slug: string }) {
  const all: ClientSupplier[] = [
    ...suppliers.approved,
    ...suppliers.pending_review,
    ...suppliers.denied,
    ...suppliers.draft,
  ];
  const [status, setStatus] = useState<string>("all");
  const statusRows = status === "all" ? all : all.filter((s) => s.approval === status);

  const { filtered, controls } = useListFilter(statusRows, {
    searchText: (r) => `${r.name ?? ""} ${r.poc_email ?? ""} ${r.poc_name ?? ""}`,
    searchPlaceholder: "supplier or email…",
    sorts: [
      { value: "status", label: "Status", compare: (a, b) => STATUS_ORDER[a.approval] - STATUS_ORDER[b.approval] || (a.name ?? "").localeCompare(b.name ?? "") },
      { value: "name", label: "Supplier (A–Z)", compare: byString((r: ClientSupplier) => r.name) },
    ],
    defaultSort: "status",
  });

  // Export in the Tenkara bulk-upload template format (doubles as the template,
  // so there's no separate blank-template download).
  const csvRows = filtered.map((r: any) => SUPPLIER_TEMPLATE_HEADERS.map((col) => (r[col] != null ? r[col] : "")));

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Client suppliers</h3>
        <span className="text-xs text-muted-foreground">
          {suppliers.total} total · {suppliers.approved.length} approved · {suppliers.pending_review.length} pending ·{" "}
          {suppliers.denied.length} denied
        </span>
      </div>
      <div className="space-y-3">
        {suppliers.total === 0 ? (
          <p className="text-sm text-muted-foreground">No suppliers linked to this client in Tenkara yet.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-3">
                {controls}
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Status</span>
                  <Select size="sm" className="min-w-[9rem]" ariaLabel="Status" value={status} onValueChange={setStatus} options={FILTER_OPTIONS} />
                </label>
              </div>
              <ListCsvButton
                filename={filenameFor(slug, "suppliers")}
                headers={[...SUPPLIER_TEMPLATE_HEADERS]}
                rows={csvRows}
                label="Export (Tenkara template)"
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        {s.name ?? "—"}
                        {s.is_marketplace && <Badge variant="secondary">marketplace</Badge>}
                      </span>
                    </TableCell>
                    <TableCell><StatusBadge s={s.approval} /></TableCell>
                    <TableCell className="text-muted-foreground text-xs">{s.poc_email ?? s.poc_name ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-xs max-w-xs truncate" title={s.approval_notes ?? undefined}>
                      {s.approval_notes ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">No suppliers match.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </div>
  );
}
