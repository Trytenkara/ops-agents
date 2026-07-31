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
import { BulkRemoveBar } from "@/components/bulk-remove-bar";
import { BulkRewriteBar } from "@/components/bulk-rewrite-bar";
import { removeDrafts } from "@/app/actions/drafts";
import { rewriteDrafts } from "@/app/actions/rewrite-draft";
import { setThreadHidden } from "@/app/actions/drafts";
import { Button } from "@/components/ui/button";
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
  hiddenLocally: boolean;
};

const KIND_META: Record<ThreadKind, { label: string; variant: string; title: string }> = {
  outbound: { label: "Outbound RFQ", variant: "default", title: "Initial outreach email to a supplier." },
  inbound: { label: "Inbound reply", variant: "success", title: "A reply drafted for a supplier's incoming email." },
};


const FILTERS: { value: "all" | ThreadKind | "hidden"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "outbound", label: "Outbound RFQs" },
  { value: "inbound", label: "Inbound replies" },
  { value: "hidden", label: "Hidden" },
];

export function ThreadsList({ rows, slug, canAct = false }: { rows: ThreadRow[]; slug: string; canAct?: boolean }) {
  const [kind, setKind] = useState<"all" | ThreadKind | "hidden">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiding, setHiding] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const toggleOne = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const byKind = useMemo(() => {
    if (kind === "hidden") return rows.filter((r) => r.hiddenLocally);
    const visible = rows.filter((r) => !r.hiddenLocally);
    return kind === "all" ? visible : visible.filter((r) => r.kind === kind);
  }, [kind, rows]);
  const counts = useMemo(() => {
    const visible = rows.filter((r) => !r.hiddenLocally);
    const c = { all: visible.length, outbound: 0, inbound: 0, hidden: rows.length - visible.length } as Record<string, number>;
    for (const r of visible) c[r.kind]++;
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
    persistKey: "threads",
  });

  const selectable = canAct;
  const filteredIds = filtered.map((r) => r.id);
  const selectedCount = filteredIds.filter((id) => selected.has(id)).length;
  const allSelected = filteredIds.length > 0 && selectedCount === filteredIds.length;
  const toggleAll = (checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of filteredIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  async function hideThread(id: string, hidden: boolean) {
    if (hidden && !window.confirm("Hide this empty conversation in Control Room? The conversation will still exist in Tenkara and will not be changed.")) return;
    setHiding(id);
    setActionMessage(null);
    const res = await setThreadHidden(id, hidden);
    setHiding(null);
    setActionMessage(res.ok ? (res.warning ?? "Hidden locally.") : (res.error ?? "Could not hide thread."));
    if (res.ok) window.location.reload();
  }

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

      {actionMessage && <p className="text-xs text-amber-700 dark:text-amber-300">{actionMessage}</p>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        {controls}
        <ListCsvButton
          filename={filenameFor(slug, "threads")}
          headers={["Kind", "Subject", "Supplier", "Material", "Status", "Assigned", "Staged"]}
          rows={csvRows}
        />
      </div>

      {selectable && (
        <>
          <BulkRewriteBar
            count={selectedCount}
            onRewrite={() => rewriteDrafts(filteredIds.filter((id) => selected.has(id)))}
            onClear={() => setSelected(new Set())}
          />
          <BulkRemoveBar
            count={selectedCount}
            noun="thread"
            onRemove={() => removeDrafts(filteredIds.filter((id) => selected.has(id)))}
            onClear={() => setSelected(new Set())}
          />
        </>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            {selectable && (
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  aria-label="Select all threads"
                  className="h-4 w-4 accent-destructive align-middle"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </TableHead>
            )}
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
              {selectable && (
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label="Select thread"
                    className="h-4 w-4 accent-destructive align-middle"
                    checked={selected.has(d.id)}
                    onChange={(e) => toggleOne(d.id, e.target.checked)}
                  />
                </TableCell>
              )}
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
              <TableCell>
                <div className="flex items-center gap-2">
                  {d.status !== "linked" && <Link href={`/work/drafts/${d.id}`} className="text-primary hover:underline text-sm">Open →</Link>}
                  {canAct && d.status === "linked" && (
                    <Button size="sm" variant="ghost" disabled={hiding === d.id} onClick={() => hideThread(d.id, !d.hiddenLocally)}>
                      {hiding === d.id ? "…" : d.hiddenLocally ? "Unhide" : "Hide"}
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={selectable ? 9 : 8} className="text-center text-muted-foreground py-8">
                No threads match.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
