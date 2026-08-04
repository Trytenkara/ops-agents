"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { useListFilter, byString, byStringBlankLast } from "@/components/use-list-filter";
import { useState } from "react";
import type { ClientSuppliers, ClientSupplier, SupplierApproval } from "@/lib/client-suppliers";
import { SupplierOperatorAssign } from "@/components/supplier-operator-assign";
import { TemplateDownloadButton } from "@/components/template-download-button";
import { SUPPLIER_TEMPLATE_HEADERS } from "@/lib/tenkara-templates";

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

export function ClientSuppliersSection({
  suppliers,
  orgId,
  autoNames,
  assignments,
  operatorOptions,
  operatorNames,
  canAct,
  claimsIgnored,
}: {
  suppliers: ClientSuppliers;
  orgId: string;
  autoNames?: Record<string, string>;   // sticky-random default owner name per supplier
  assignments?: Record<string, string>; // manual operator_id per supplier
  operatorOptions?: { id: string; name: string }[];
  operatorNames?: Record<string, string>; // operator_id → name (for read-only display)
  canAct?: boolean;
  claimsIgnored?: boolean;              // org on "auto, reassign all": auto beats a claim
}) {
  const all: ClientSupplier[] = [
    ...suppliers.approved,
    ...suppliers.pending_review,
    ...suppliers.denied,
    ...suppliers.draft,
  ];
  const [status, setStatus] = useState<string>("all");
  const statusRows = status === "all" ? all : all.filter((s) => s.approval === status);

  // Who the Operator column shows, and whether that came from the auto spread or
  // an operator's claim. A claim wins, unless the org runs "auto, reassign all".
  const ownerOf = (s: ClientSupplier): { name: string; auto: boolean } | null => {
    const claimed = assignments?.[s.id];
    const claimName = claimed ? operatorNames?.[claimed] ?? null : null;
    const autoName = autoNames?.[s.id] ?? null;
    const order: { name: string | null; auto: boolean }[] = claimsIgnored
      ? [{ name: autoName, auto: true }, { name: claimName, auto: false }]
      : [{ name: claimName, auto: false }, { name: autoName, auto: true }];
    const hit = order.find((o) => o.name);
    return hit ? { name: hit.name!, auto: hit.auto } : null;
  };
  const operatorNameOf = (s: ClientSupplier): string | null => ownerOf(s)?.name ?? null;

  const { filtered, controls } = useListFilter(statusRows, {
    searchText: (r) => `${r.name ?? ""} ${r.poc_email ?? ""} ${r.poc_name ?? ""} ${operatorNameOf(r) ?? ""}`,
    searchPlaceholder: "supplier, email or operator…",
    sorts: [
      { value: "status", label: "Status", compare: (a, b) => STATUS_ORDER[a.approval] - STATUS_ORDER[b.approval] || (a.name ?? "").localeCompare(b.name ?? "") },
      { value: "name", label: "Supplier (A–Z)", compare: byString((r: ClientSupplier) => r.name) },
      {
        value: "operator",
        label: "Operator (A–Z)",
        compare: (a, b) => byStringBlankLast(operatorNameOf)(a, b) || (a.name ?? "").localeCompare(b.name ?? ""),
      },
    ],
    defaultSort: "status",
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Client suppliers</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {suppliers.total} total · {suppliers.approved.length} approved · {suppliers.pending_review.length} pending ·{" "}
            {suppliers.denied.length} denied
          </span>
          <TemplateDownloadButton
            headers={SUPPLIER_TEMPLATE_HEADERS}
            filename="tenkara-suppliers-template.csv"
            label="Supplier template"
          />
        </div>
      </div>
      <div className="space-y-3">
        {suppliers.total === 0 ? (
          <p className="text-sm text-muted-foreground">No suppliers linked to this client in Tenkara yet.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              {controls}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Status</span>
                <Select size="sm" className="min-w-[9rem]" ariaLabel="Status" value={status} onValueChange={setStatus} options={FILTER_OPTIONS} />
              </label>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Qualified</TableHead>
                  <TableHead>Operator</TableHead>
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
                    <TableCell>
                      {s.qualified ? <Badge variant="success">Qualified</Badge> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-xs">
                      {canAct ? (
                        <SupplierOperatorAssign
                          orgId={orgId}
                          supplierId={s.id}
                          assignedId={assignments?.[s.id] ?? null}
                          autoName={autoNames?.[s.id] ?? null}
                          options={operatorOptions ?? []}
                          claimsIgnored={claimsIgnored}
                        />
                      ) : ownerOf(s) ? (
                        <Badge variant="outline">
                          {ownerOf(s)!.name}
                          {ownerOf(s)!.auto ? <span className="text-muted-foreground"> (auto)</span> : null}
                        </Badge>
                      ) : (
                        <span className="italic text-muted-foreground">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{s.poc_email ?? s.poc_name ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground text-xs max-w-xs truncate" title={s.approval_notes ?? undefined}>
                      {s.approval_notes ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No suppliers match.</TableCell>
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
