"use client";

import { useEffect, useMemo, useState } from "react";
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
import { attachAlternateEmail } from "@/app/actions/supplier-emails";
import { Button } from "@/components/ui/button";
import { filenameFor } from "@/lib/csv";
import { useListFilter, usePersistedState, byString, byDateDesc, byStringBlankLast } from "@/components/use-list-filter";
import { Select } from "@/components/ui/select";

export type ThreadKind = "outbound" | "inbound" | "inquiry";

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
  emailClient: string;
  createdAt: string | null;
  metadata: any;
  assignedName: string | null;
  assignedEmail: string | null;
  assignedRole: string | null;
  reviewerName: string | null;
  hiddenLocally: boolean;
  aliases: { id: string; email: string }[];
};

const KIND_META: Record<ThreadKind, { label: string; variant: string; title: string }> = {
  outbound: { label: "Outbound RFQ", variant: "default", title: "Initial outreach email to a supplier." },
  inbound: { label: "Inbound reply", variant: "success", title: "A reply drafted for a supplier's incoming email." },
  inquiry: {
    label: "Platform inquiry",
    variant: "warn",
    title: "Sourcing inquiry submitted through an aggregator's own web form. There is no email thread until the seller replies.",
  },
};


const FILTERS: { value: "all" | ThreadKind | "hidden"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "outbound", label: "Outbound RFQs" },
  { value: "inbound", label: "Inbound replies" },
  { value: "inquiry", label: "Platform inquiries" },
  { value: "hidden", label: "Hidden" },
];

// Every thread for the org is loaded at once, so the table renders a window of
// rows and grows it as the operator scrolls. Keeps a 900-row org responsive.
const SCROLL_PAGE = 100;

// An operator is identified by email where we have one (display names collide),
// falling back to the name. Blank means the thread is unassigned.
function assigneeKey(r: ThreadRow): string {
  return (r.assignedEmail ?? r.assignedName ?? "").trim().toLowerCase() || "unassigned";
}

export function ThreadsList({ rows, slug, orgId, canAct = false }: { rows: ThreadRow[]; slug: string; orgId: string; canAct?: boolean }) {
  const [kind, setKind] = useState<"all" | ThreadKind | "hidden">("all");
  const [assignee, setAssignee] = usePersistedState("threads:assignee", "all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiding, setHiding] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [aliasEmail, setAliasEmail] = useState("");
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

  const assigneeOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const r of byKind) {
      const key = assigneeKey(r);
      const entry = counts.get(key) ?? { label: key === "unassigned" ? "Unassigned" : r.assignedName ?? r.assignedEmail ?? key, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    const named = Array.from(counts.entries())
      .filter(([key]) => key !== "unassigned")
      .sort((a, b) => a[1].label.localeCompare(b[1].label));
    const unassigned = counts.get("unassigned");
    return [
      { value: "all", label: `All assignees (${byKind.length})` },
      ...named.map(([value, v]) => ({ value, label: `${v.label} (${v.count})` })),
      ...(unassigned ? [{ value: "unassigned", label: `Unassigned (${unassigned.count})` }] : []),
    ];
  }, [byKind]);

  const byAssignee = useMemo(
    () => (assignee === "all" ? byKind : byKind.filter((r) => assigneeKey(r) === assignee)),
    [byKind, assignee]
  );

  const { filtered, controls } = useListFilter(byAssignee, {
    searchText: (r) => `${r.subject ?? ""} ${r.supplierName ?? ""} ${r.materialName ?? ""} ${r.assignedName ?? ""} ${r.assignedEmail ?? ""}`,
    searchPlaceholder: "subject, supplier, material, assignee…",
    sorts: [
      { value: "newest", label: "Newest", compare: byDateDesc((r: ThreadRow) => r.createdAt) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: ThreadRow) => r.supplierName) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: ThreadRow) => r.materialName) },
      { value: "status", label: "Status", compare: byString((r: ThreadRow) => r.status) },
      {
        value: "assignee",
        label: "Assigned (A–Z)",
        compare: (a, b) =>
          byStringBlankLast((r: ThreadRow) => r.assignedName ?? r.assignedEmail)(a, b) || byDateDesc((r: ThreadRow) => r.createdAt)(a, b),
      },
    ],
    defaultSort: "newest",
    persistKey: "threads",
  });

  // A persisted operator who has no threads in this view would otherwise leave
  // the table permanently empty with no visible cause.
  useEffect(() => {
    if (assignee !== "all" && !assigneeOptions.some((o) => o.value === assignee)) setAssignee("all");
  }, [assignee, assigneeOptions, setAssignee]);

  const [visibleCount, setVisibleCount] = useState(SCROLL_PAGE);
  useEffect(() => setVisibleCount(SCROLL_PAGE), [filtered]);
  const visibleRows = filtered.slice(0, visibleCount);

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

  async function attachAlias(row: ThreadRow) {
    setActionMessage(null);
    const res = await attachAlternateEmail(orgId, row.id, aliasEmail);
    if (!res.ok) {
      setActionMessage(res.error ?? "Could not attach email.");
      return;
    }
    setAttaching(null);
    setAliasEmail("");
    window.location.reload();
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
        <div className="flex flex-wrap items-end gap-3">
          {controls}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Assigned to</span>
            <Select
              size="sm"
              className="min-w-[13rem]"
              ariaLabel="Filter by assigned operator"
              value={assignee}
              onValueChange={setAssignee}
              options={assigneeOptions}
            />
          </label>
        </div>
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
      <Table
        viewportClassName="max-h-[70vh] overflow-y-auto"
        onViewportScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) {
            setVisibleCount((v) => (v >= filtered.length ? v : v + SCROLL_PAGE));
          }
        }}
      >
        <TableHeader className="sticky top-0 z-10 bg-card">
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
          {visibleRows.map((d) => (
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
                <div>{d.supplierName ?? (d.supplierId ? <span className="text-xs text-muted-foreground">name unavailable</span> : "—")}</div>
                {d.aliases.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {d.aliases.map((alias) => (
                      <span key={alias.id} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px]">
                        {alias.email}
                      </span>
                    ))}
                  </div>
                )}
                {canAct && d.emailClient === "rod_app" && (
                  attaching === d.id ? (
                    <div className="mt-1 flex gap-1">
                      <input value={aliasEmail} onChange={(e) => setAliasEmail(e.target.value)} placeholder="alternate@email.com" className="w-40 rounded border border-border bg-background px-1 py-0.5 text-[10px]" />
                      <button type="button" className="text-[10px] text-primary" onClick={() => attachAlias(d)}>Add</button>
                      <button type="button" className="text-[10px] text-muted-foreground" onClick={() => { setAttaching(null); setAliasEmail(""); }}>Cancel</button>
                    </div>
                  ) : <button type="button" className="mt-1 text-[10px] text-primary hover:underline" onClick={() => setAttaching(d.id)}>Attach alternate email</button>
                )}
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
      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {visibleRows.length < filtered.length
            ? `Showing ${visibleRows.length} of ${filtered.length} threads. Scroll the table for more.`
            : `Showing all ${filtered.length} thread${filtered.length === 1 ? "" : "s"}.`}
        </p>
      )}
    </div>
  );
}
