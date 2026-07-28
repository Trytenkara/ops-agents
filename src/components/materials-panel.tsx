"use client";

import { useRef, useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { RunNowButton } from "@/components/run-now-button";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Select, type SelectOption } from "@/components/ui/select";
import type { MaterialProfile, MaterialProfileRow, OrderLineRow } from "@/lib/material-profile";
import type { MaterialSourcingStatus, SourcingCounts } from "@/lib/material-sourcing-status";
import { uploadAndParsePO, confirmOrder, deleteOrder, rematchOrders, editOrder } from "@/app/actions/material-profile";
import { approveStagedQuote, dismissStagedQuote } from "@/app/actions/staged-quotes";
import { saveSourcingNotes } from "@/app/actions/client-settings";
import { saveClientTag } from "@/app/actions/material-client-tags";
import { createOrgClient, deleteOrgClient } from "@/app/actions/org-clients";

function fmtQty(qty: number | null, unit: string | null): string {
  if (qty == null) return "—";
  return `${qty.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

// Recognized grade/standard/form tokens — a grade that includes one of these is
// specific enough. Used to spot ambiguous short codes (e.g. "GBB") that aren't a
// real standard and don't say which form the client actually needs.
const KNOWN_GRADE_TOKENS = new Set([
  "usp", "fcc", "acs", "bp", "ep", "jp", "ph", "eur", "nf", "ip", "reagent", "analytical", "lab",
  "food", "feed", "pharma", "pharmaceutical", "cosmetic", "cosmetics", "technical", "tech", "industrial",
  "agricultural", "electronic", "medical", "kosher", "halal", "organic", "natural", "synthetic",
  "anhydrous", "monohydrate", "dihydrate", "hydrous", "hcl", "base", "salt", "sulfate", "sulphate",
  "powder", "granular", "granules", "crystal", "crystalline", "flake", "flakes", "liquid", "solution",
  "pellet", "pellets", "fine", "coarse", "micronized", "grade",
]);

// A material's grade is a "gap" when it's missing, too basic (purity only), or
// ambiguous — a short code/abbreviation that names no recognized form/standard
// (e.g. "GBB"), since the client needs to say which type sourcing should match.
function gradeGap(grade: string | null | undefined): "missing" | "weak" | "ambiguous" | null {
  const g = (grade ?? "").trim().toLowerCase();
  if (!g) return "missing";
  // Only a purity/percentage value, no form descriptor → too basic.
  const purityOnly =
    /^[≥>~\s]*\d+(\.\d+)?\s*%?\s*(min|minimum)?\s*(purity|pure)?$/.test(g) ||
    /^(purity|pure|assay)\s*[:\-]?\s*[≥>~]?\s*\d+(\.\d+)?\s*%?$/.test(g);
  if (purityOnly) return "weak";
  // Ambiguous: a single short token (≤4 chars, no digits) that isn't a known
  // standard/form — e.g. "GBB". Multi-word or recognized grades are fine.
  const tokens = g.split(/[\s,/]+/).filter(Boolean);
  const hasKnown = tokens.some((t) => KNOWN_GRADE_TOKENS.has(t));
  const hasDigit = /\d/.test(g);
  if (!hasKnown && !hasDigit && tokens.length === 1 && tokens[0].length <= 4) return "ambiguous";
  return null;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleDateString();
}

const FREQ_VARIANT: Record<string, "default" | "secondary"> = {
  "Monthly+": "default",
  Quarterly: "default",
  Annual: "secondary",
  Infrequent: "secondary",
  "No data": "secondary",
};

export interface MaterialQuote {
  id: string;
  supplier_name: string | null;
  price: number | null;
  case_size: number | null;
  unit_of_measurement: string | null;
  unit_price: number | null;
  grade: string | null;
  status: string;
  confidence: string | null;
  created_at: string;
}

export type OrgClient = { id: string; name: string };

export function MaterialsPanel({
  orgId,
  slug,
  profile,
  canEdit,
  statuses,
  quotesByMaterial,
  sourcingNotes,
  clientTags,
  orgClients: initialOrgClients = [],
}: {
  orgId: string;
  slug: string;
  profile: MaterialProfile;
  canEdit: boolean;
  statuses?: Record<string, MaterialSourcingStatus>;
  quotesByMaterial?: Record<string, MaterialQuote[]>;
  sourcingNotes?: string | null;
  clientTags?: Record<string, { orgClientId: string | null; isPriority: boolean }>;
  orgClients?: OrgClient[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [notes, setNotes] = useState(sourcingNotes ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  const [clientFilter, setClientFilter] = useState("all");
  const [priorityOnly, setPriorityOnly] = useState(false);
  // Optimistic org_clients list — updated immediately on add/delete
  const [orgClients, setOrgClients] = useState<OrgClient[]>(initialOrgClients);
  const [showManageClients, setShowManageClients] = useState(false);
  const [newClientName, setNewClientName] = useState("");
  const [clientMgmtPending, startClientMgmt] = useTransition();

  const filteredMaterials = profile.materials.filter((m) => {
    const tag = m.tenkaraMaterialId ? clientTags?.[m.tenkaraMaterialId] : undefined;
    if (priorityOnly && !tag?.isPriority) return false;
    if (clientFilter !== "all") return tag?.orgClientId === clientFilter;
    return true;
  });

  const handleAddClient = () => {
    const trimmed = newClientName.trim();
    if (!trimmed) return;
    startClientMgmt(async () => {
      const result = await createOrgClient(orgId, trimmed);
      if (result.ok && result.id) {
        setOrgClients((prev) => [...prev, { id: result.id!, name: trimmed }].sort((a, b) => a.name.localeCompare(b.name)));
        setNewClientName("");
      }
    });
  };

  const handleDeleteClient = (clientId: string) => {
    startClientMgmt(async () => {
      const result = await deleteOrgClient(clientId);
      if (result.ok) {
        setOrgClients((prev) => prev.filter((c) => c.id !== clientId));
        if (clientFilter === clientId) setClientFilter("all");
        router.refresh(); // refresh so tagged materials clear
      }
    });
  };

  function run(fn: () => Promise<{ ok: boolean; error?: string; parsed?: number }>, okText: string) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      if (r.ok) setMsg({ kind: "ok", text: r.parsed != null ? `${okText} (${r.parsed} line${r.parsed === 1 ? "" : "s"})` : okText });
      else setMsg({ kind: "err", text: r.error ?? "failed" });
      router.refresh();
    });
  }

  const parsedToReview = [...profile.materials.flatMap((m) => m.orders), ...profile.unmatchedOrders].filter(
    (o) => o.status === "parsed"
  );

  // Options for manually filing an unmatched order under the right material.
  const assignOptions: SelectOption[] = profile.materials
    .filter((m) => m.tenkaraMaterialId)
    .map((m) => ({ value: m.tenkaraMaterialId as string, label: m.grade ? `${m.label} — ${m.grade}` : m.label }));

  return (
    <div className="space-y-5">
      {canEdit && (
        <Card className="tb-surface shadow-none">
          <CardContent className="py-4 flex flex-wrap items-center gap-3">
            <div className="text-sm">
              <div className="font-medium">Upload a PO</div>
              <div className="text-xs text-muted-foreground">PDF, CSV or Excel — parsed into order lines (actual vs PO qty, expiries).</div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.csv,.txt,.xlsx,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const fd = new FormData();
                fd.set("file", f);
                run(() => uploadAndParsePO(orgId, fd), "PO parsed");
                if (fileRef.current) fileRef.current.value = "";
              }}
            />
            <div className="ml-auto flex items-center gap-2">
              {profile.tenkaraConnected && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  title="Re-check every unconfirmed order against this client's Tenkara materials and fix or clear wrong matches. Confirmed orders are left alone."
                  onClick={() => run(() => rematchOrders(orgId), "Re-matched orders")}
                >
                  {pending ? "Working…" : "Re-match orders"}
                </Button>
              )}
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => fileRef.current?.click()}>
                {pending ? "Working…" : "Upload PO"}
              </Button>
            </div>
            <div className="w-full">
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">Sourcing instructions</div>
              <p className="text-[11px] text-muted-foreground mb-1">
                Context and rules for sourcing this client. Country bans written here (e.g. “No China”) are now honored by discovery &amp; outreach, alongside preferred suppliers and other constraints.
              </p>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={!canEdit || pending}
                rows={2}
                placeholder="e.g. No China. Prefer domestic manufacturers. Avoid brokers. Client already uses Brenntag for X…"
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              />
              <div className="mt-1 flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pending || notes === (sourcingNotes ?? "")}
                  onClick={() => run(() => saveSourcingNotes(orgId, notes), "Notes saved")}
                >
                  Save notes
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {msg && (
        <p className={msg.kind === "ok" ? "text-xs text-green-700" : "text-xs text-red-600"}>{msg.text}</p>
      )}

      {(() => {
        const gaps = profile.materials.filter((m) => gradeGap(m.grade));
        if (gaps.length === 0) return null;
        const gapLabel: Record<string, string> = { missing: "no grade", weak: "purity only", ambiguous: "ambiguous code" };
        return (
          <div className="rounded-lg border border-amber-300/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 space-y-2">
            <div>
              <span className="font-medium">{gaps.length} material{gaps.length === 1 ? "" : "s"} need a clearer grade.</span>{" "}
              A missing grade, a bare purity % (e.g. “100% purity”), or an ambiguous code (e.g. “GBB”) doesn&apos;t say which form/type (HCl, base, USP, anhydrous…). Specify a grade on each so sourcing matches the right product:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {gaps.map((m) => {
                const gap = gradeGap(m.grade);
                const name = m.label.length > 48 ? `${m.label.slice(0, 48)}…` : m.label;
                return (
                  <span
                    key={m.tenkaraMaterialId ?? m.label}
                    title={`${m.label} — ${gap ? gapLabel[gap] : ""}`}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-400/50 bg-amber-500/10 px-1.5 py-0.5 text-xs"
                  >
                    {name}
                    {gap && <span className="opacity-70">· {gapLabel[gap]}</span>}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      {!profile.tenkaraConnected ? (
        <Card className="tb-surface shadow-none">
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">This client isn&apos;t linked to a Tenkara org yet, so materials can&apos;t be loaded.</p>
            <p className="text-xs text-muted-foreground mt-2">Uploaded POs are still stored and shown below once linked.</p>
          </CardContent>
        </Card>
      ) : profile.materials.length === 0 ? (
        <Card className="tb-surface shadow-none">
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">No materials found for this client.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <h3 className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Materials</h3>
          <div className="flex flex-wrap items-center gap-2">
            {orgClients.length > 0 && (
              <select
                value={clientFilter}
                onChange={(e) => setClientFilter(e.target.value)}
                className="h-7 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="all">All clients</option>
                {orgClients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={priorityOnly}
                onChange={(e) => setPriorityOnly(e.target.checked)}
                className="rounded border-input"
              />
              Priority only
            </label>
            {(clientFilter !== "all" || priorityOnly) && (
              <button
                onClick={() => { setClientFilter("all"); setPriorityOnly(false); }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
            {(clientFilter !== "all" || priorityOnly) && (
              <span className="text-xs text-muted-foreground ml-auto">
                {filteredMaterials.length} of {profile.materials.length}
              </span>
            )}
            {canEdit && (
              <button
                onClick={() => setShowManageClients((v) => !v)}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground"
              >
                {showManageClients ? "Hide clients ▾" : "Manage clients ▸"}
              </button>
            )}
          </div>
          {canEdit && showManageClients && (
            <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5 space-y-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Client folders</div>
              {orgClients.length === 0 && (
                <p className="text-xs text-muted-foreground">No clients yet. Add one below.</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {orgClients.map((c) => (
                  <span key={c.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs">
                    {c.name}
                    <button
                      onClick={() => handleDeleteClient(c.id)}
                      disabled={clientMgmtPending}
                      title={`Remove "${c.name}"`}
                      className="text-muted-foreground hover:text-destructive ml-0.5"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddClient()}
                  placeholder="New client name…"
                  disabled={clientMgmtPending}
                  className="h-7 flex-1 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
                <button
                  onClick={handleAddClient}
                  disabled={clientMgmtPending || !newClientName.trim()}
                  className="h-7 rounded-md border border-input bg-background px-2.5 text-xs hover:bg-secondary disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </div>
          )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Material</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Sourcing</TableHead>
                  <TableHead>Annual req.</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Avg order</TableHead>
                  <TableHead>Min shelf-life (mat. &amp; COA)</TableHead>
                  <TableHead>Current quote expiry</TableHead>
                  <TableHead className="text-right">Discovery</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMaterials.map((m) => (
                  <MaterialRow
                    key={m.tenkaraMaterialId ?? m.label}
                    m={m}
                    orgId={orgId}
                    canEdit={canEdit}
                    pending={pending}
                    run={run}
                    status={m.tenkaraMaterialId ? statuses?.[m.tenkaraMaterialId] : undefined}
                    quotes={m.tenkaraMaterialId ? quotesByMaterial?.[m.tenkaraMaterialId] ?? [] : []}
                    base={`/work/orgs/${slug}`}
                    tag={m.tenkaraMaterialId ? clientTags?.[m.tenkaraMaterialId] : undefined}
                    orgClients={orgClients}
                  />
                ))}
                {filteredMaterials.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-6 text-center text-sm text-muted-foreground">
                      No materials match the current filter.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
        </div>
      )}

      {profile.unmatchedOrders.length > 0 && (
        <Card className="tb-surface shadow-none">
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">
              Unmatched orders ({profile.unmatchedOrders.length})
            </CardTitle>
            {canEdit && (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => run(() => rematchOrders(orgId), "Re-matched")}
              >
                {pending ? "Working…" : "Re-match by name + grade"}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Parsed from POs but not matched to a Tenkara material. Re-match attempts name + grade
              identifiers automatically; confirm or delete the rest.
            </p>
            <OrderList orders={profile.unmatchedOrders} canEdit={canEdit} pending={pending} run={run} assignOptions={assignOptions} />
          </CardContent>
        </Card>
      )}

      {parsedToReview.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {parsedToReview.length} parsed order line{parsedToReview.length === 1 ? "" : "s"} awaiting review (marked “parsed”).
        </p>
      )}
    </div>
  );
}

// Ordered pipeline stages for the per-material funnel. Counts drop by orders of
// magnitude across stages, so this is a fixed-cell stepper (not a proportional
// bar) — each stage always shows its number. Single hue (sky), lightness-stepped
// by reached/current, so it stays colorblind-safe and doesn't compete with the
// semantic state chip above it.
const FUNNEL_STAGES = [
  { key: "leads", label: "Leads" },
  { key: "drafted", label: "Drafted" },
  { key: "sent", label: "Sent" },
  { key: "quotes", label: "Quotes" },
] as const;

function SourcingFunnel({ counts, base, tab }: { counts: SourcingCounts; base: string; tab: string | null }) {
  // Furthest stage that has any activity — the material's real "where it's at".
  const current = FUNNEL_STAGES.reduce((acc, s, i) => (counts[s.key] > 0 ? i : acc), -1);
  // Nothing in the pipeline yet → no funnel (the state chip already says so).
  if (current < 0) return null;
  const extra = [
    counts.compiling ? `${counts.compiling} compiling the first email` : null,
    counts.followup ? `${counts.followup} queued for follow-up` : null,
  ].filter(Boolean).join(" · ");
  const bar = (
    <div className="mt-1 flex items-stretch gap-0.5" title={extra || "Leads → drafted → sent → quotes"}>
      {FUNNEL_STAGES.map((s, i) => {
        const v = counts[s.key];
        const reached = v > 0;
        const isCurrent = i === current;
        return (
          <div
            key={s.key}
            className={cn(
              "flex min-w-[2.3rem] flex-1 flex-col items-center rounded px-1 py-0.5 leading-none",
              reached ? "bg-sky-500/15 text-sky-700 dark:text-sky-300" : "bg-muted/50 text-muted-foreground",
              isCurrent && "bg-sky-500/30 ring-1 ring-sky-500/50 font-semibold"
            )}
          >
            <span className="tabular-nums text-[11px]">{v}</span>
            <span className="text-[8px] uppercase tracking-wide opacity-70">{s.label}</span>
          </div>
        );
      })}
    </div>
  );
  return tab ? (
    <Link href={`${base}${tab}`} onClick={(e) => e.stopPropagation()} className="block hover:opacity-90">
      {bar}
    </Link>
  ) : (
    bar
  );
}

function SourcingChip({ status, base }: { status?: MaterialSourcingStatus; base: string }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const chip = (
    <span className={cn("inline-flex flex-col rounded-md px-2 py-1 text-left leading-tight", status.cls)}>
      <span className="text-[11px] font-semibold uppercase tracking-wide">{status.label}</span>
      <span className="text-[10px] opacity-80">{status.reason}</span>
    </span>
  );
  return (
    <div className="flex flex-col gap-0.5 min-w-[10.5rem]">
      {status.tab ? (
        <Link href={`${base}${status.tab}`} onClick={(e) => e.stopPropagation()} className="inline-block hover:opacity-80 self-start">
          {chip}
        </Link>
      ) : (
        <span className="self-start">{chip}</span>
      )}
      {status.counts && <SourcingFunnel counts={status.counts} base={base} tab={status.tab} />}
    </div>
  );
}

function MaterialRow({
  m,
  orgId,
  canEdit,
  pending,
  run,
  status,
  quotes,
  base,
  tag,
  orgClients = [],
}: {
  m: MaterialProfileRow;
  orgId: string;
  canEdit: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string; parsed?: number }>, okText: string) => void;
  status?: MaterialSourcingStatus;
  quotes: MaterialQuote[];
  base: string;
  tag?: { orgClientId: string | null; isPriority: boolean };
  orgClients?: OrgClient[];
}) {
  const [open, setOpen] = useState(false);
  // Optimistic priority: flips immediately on click; clears when server state arrives
  const [optimisticPriority, setOptimisticPriority] = useState<boolean | null>(null);
  const [tagPending, startTagTransition] = useTransition();
  const tagRouter = useRouter();

  const rec = m.recommendedShelfLifeMonths;
  // Always expandable: even with no orders/quotes there are material details
  // (grade, INCI, brand, need type) worth seeing to sanity-check matching.
  const detailCount = quotes.length + m.orders.length;

  const currentClientId = tag?.orgClientId ?? null;
  const currentClientName = orgClients.find((c) => c.id === currentClientId)?.name ?? "";
  // Display: optimistic value while save is in-flight, server value once refreshed
  const displayPriority = optimisticPriority !== null ? optimisticPriority : (tag?.isPriority ?? false);

  // Once router.refresh() lands and tag prop updates, drop the optimistic override
  useEffect(() => { setOptimisticPriority(null); }, [tag?.isPriority]);

  const doSaveTag = (clientId: string | null, priority: boolean) => {
    if (!m.tenkaraMaterialId) return;
    startTagTransition(async () => {
      await saveClientTag(orgId, m.tenkaraMaterialId!, m.label, clientId, priority);
      tagRouter.refresh();
    });
  };

  const handleClientChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    doSaveTag(e.target.value || null, displayPriority);
  };

  const togglePriority = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !displayPriority;
    setOptimisticPriority(next);
    doSaveTag(currentClientId, next);
  };

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <TableCell className="font-medium">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              {canEdit && m.tenkaraMaterialId && (
                <button
                  onClick={togglePriority}
                  title={displayPriority ? "Priority — click to remove" : "Mark as priority (moves to front of discovery queue)"}
                  className={cn(
                    "text-base leading-none shrink-0 transition-colors",
                    displayPriority ? "text-amber-500 hover:text-amber-400" : "text-muted-foreground/40 hover:text-amber-400"
                  )}
                >
                  {displayPriority ? "★" : "☆"}
                </button>
              )}
              <span>{m.label}</span>
              <span className="text-xs text-muted-foreground">{open ? "▾" : "▸"}{detailCount > 0 ? ` ${detailCount}` : ""}</span>
            </div>
            {canEdit && m.tenkaraMaterialId && orgClients.length > 0 ? (
              <select
                value={currentClientId ?? ""}
                onChange={handleClientChange}
                onClick={(e) => e.stopPropagation()}
                disabled={tagPending}
                className={cn(
                  "text-xs rounded border border-input bg-transparent px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring w-36",
                  currentClientName ? "text-sky-700 dark:text-sky-400 font-medium" : "text-muted-foreground"
                )}
              >
                <option value="">— none —</option>
                {orgClients.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : currentClientName ? (
              <span className="text-xs text-sky-700 dark:text-sky-400 font-medium">{currentClientName}</span>
            ) : null}
          </div>
        </TableCell>
        <TableCell>
          {(() => {
            const gap = gradeGap(m.grade);
            if (gap === "missing")
              return (
                <Badge variant="warn" title="No grade/form set. Specify the grade (e.g. HCl, base, USP) — a name alone (e.g. “GBB”) can map to several forms.">
                  Needs grade
                </Badge>
              );
            if (gap === "weak")
              return (
                <span className="inline-flex items-center gap-1">
                  <Badge variant="secondary">{m.grade}</Badge>
                  <Badge variant="warn" title="Too basic — a purity % alone doesn't say which form/grade (HCl, base, USP, anhydrous…). Specify it so sourcing matches the right product.">
                    too basic
                  </Badge>
                </span>
              );
            if (gap === "ambiguous")
              return (
                <span className="inline-flex items-center gap-1">
                  <Badge variant="secondary">{m.grade}</Badge>
                  <Badge variant="warn" title="Looks incomplete — this code doesn't say which grade/form (e.g. USP, food, HCl, anhydrous, powder). Which type does the client need?">
                    which type?
                  </Badge>
                </span>
              );
            return <Badge variant="secondary">{m.grade}</Badge>;
          })()}
        </TableCell>
        <TableCell><SourcingChip status={status} base={base} /></TableCell>
        <TableCell>{m.annualVolume != null ? `${m.annualVolume.toLocaleString()}${m.volumeUnit ? ` ${m.volumeUnit}` : ""}/yr` : "—"}</TableCell>
        <TableCell>
          <Badge variant={FREQ_VARIANT[m.frequency.label]}>{m.frequency.label}</Badge>
        </TableCell>
        <TableCell>{fmtQty(m.avgOrderQty != null ? Math.round(m.avgOrderQty) : null, m.volumeUnit)}</TableCell>
        <TableCell>{rec != null ? `≥ ${rec} mo` : <span className="text-muted-foreground">needs orders</span>}</TableCell>
        <TableCell>
          {fmtDate(m.currentQuoteExpiry)}
          {m.shortShelfLife && (
            <Badge variant="secondary" className="ml-2 text-red-600 border-red-300">request longer</Badge>
          )}
        </TableCell>
        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
          {canEdit && m.tenkaraMaterialId ? (
            <RunNowButton
              agentSlug="agent-03-lead-creator"
              isRunning={false}
              label="Run"
              input={{ materialId: m.tenkaraMaterialId }}
              stayOnPage
            />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={9} className="bg-secondary/20">
            <div className="space-y-4 py-1">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  Material details
                </div>
                <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-muted-foreground">Grade / form</dt>
                  <dd>{m.grade ? m.grade : <span className="text-amber-700 dark:text-amber-400">not specified — sourcing may match the wrong form</span>}</dd>
                  {m.inci && (<><dt className="text-muted-foreground">INCI</dt><dd>{m.inci}</dd></>)}
                  {m.tradeName && m.tradeName !== m.label && (<><dt className="text-muted-foreground">Brand / trade</dt><dd>{m.tradeName}</dd></>)}
                  {m.needType && (<><dt className="text-muted-foreground">Need type</dt><dd>{m.needType}</dd></>)}
                  <dt className="text-muted-foreground">Annual req.</dt>
                  <dd>{m.annualVolume != null ? `${m.annualVolume.toLocaleString()}${m.volumeUnit ? ` ${m.volumeUnit}` : ""}/yr` : "—"}</dd>
                </dl>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                  Quotes <span className="text-foreground">· {quotes.length}</span>
                </div>
                {quotes.length > 0 ? (
                  <QuoteList quotes={quotes} canEdit={canEdit} pending={pending} run={run} />
                ) : (
                  <p className="text-xs text-muted-foreground">No collected quotes yet.</p>
                )}
              </div>
              {m.orders.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                    Orders &amp; uploads <span className="text-foreground">· {m.orders.length}</span>
                  </div>
                  <OrderList orders={m.orders} canEdit={canEdit} pending={pending} run={run} />
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function QuoteStatusBadge({ status }: { status: string }) {
  const v =
    status === "approved" ? "success" : status === "dismissed" ? "secondary" : status === "pending_review" ? "warn" : "secondary";
  const label = status === "pending_review" ? "pending" : status;
  return <Badge variant={v as any}>{label}</Badge>;
}

function QuoteList({
  quotes,
  canEdit,
  pending,
  run,
}: {
  quotes: MaterialQuote[];
  canEdit: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string; parsed?: number }>, okText: string) => void;
}) {
  return (
    <div className="space-y-1">
      {quotes.map((q) => {
        const perUnit = q.unit_price != null ? q.unit_price : q.price != null && q.case_size ? q.price / q.case_size : null;
        return (
          <div
            key={q.id}
            className="grid grid-cols-[5rem_minmax(0,1.4fr)_7rem_minmax(0,1fr)_8rem] items-center gap-x-3 text-xs"
          >
            <span><QuoteStatusBadge status={q.status} /></span>
            <span className="font-medium truncate" title={q.supplier_name ?? undefined}>{q.supplier_name ?? "—"}</span>
            <span className="tabular-nums">
              {perUnit != null ? `$${perUnit.toLocaleString(undefined, { maximumFractionDigits: 4 })}${q.unit_of_measurement ? `/${q.unit_of_measurement}` : ""}` : "—"}
            </span>
            <span className="text-muted-foreground truncate">
              {q.price != null ? `$${q.price} / ${q.case_size ?? "?"} ${q.unit_of_measurement ?? ""}` : ""}
              {q.grade ? ` · ${q.grade}` : ""}
              {q.confidence ? ` · conf ${q.confidence}` : ""}
            </span>
            <span className="flex items-center justify-end gap-3">
              {canEdit && q.status === "pending_review" && (
                <>
                  <button className="text-green-700 hover:underline disabled:opacity-50" disabled={pending} onClick={() => run(() => approveStagedQuote(q.id), "Quote approved")}>approve</button>
                  <button className="text-red-600 hover:underline disabled:opacity-50" disabled={pending} onClick={() => run(() => dismissStagedQuote(q.id), "Quote dismissed")}>dismiss</button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function OrderList({
  orders,
  canEdit,
  pending,
  run,
  assignOptions,
}: {
  orders: OrderLineRow[];
  canEdit: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string; parsed?: number }>, okText: string) => void;
  assignOptions?: SelectOption[];
}) {
  return (
    <div className="space-y-1 py-1">
      {orders.map((o) => (
        <div key={o.id} className="grid grid-cols-[5rem_minmax(0,1.4fr)_7rem_minmax(0,1fr)_minmax(8rem,auto)] items-center gap-x-3 text-xs">
          <span className="text-muted-foreground">{fmtDate(o.order_date)}</span>
          <span className="truncate" title={`${o.material_label ?? ""}${o.supplier_name ? ` · ${o.supplier_name}` : ""}`}>
            {o.material_label && <span className="font-medium">{o.material_label}</span>}
            {o.supplier_name && <span className="text-muted-foreground">{o.material_label ? " · " : ""}{o.supplier_name}</span>}
          </span>
          <span className="tabular-nums">{fmtQty(o.ordered_qty, o.qty_unit)}</span>
          <span className="text-muted-foreground truncate tabular-nums">
            {o.unit_price != null ? `$${o.unit_price}/u` : ""}
            {o.po_qty != null && o.po_qty !== o.ordered_qty ? ` · PO ${fmtQty(o.po_qty, o.qty_unit)}` : ""}
            {o.coa_expiry ? ` · COA ${fmtDate(o.coa_expiry)}` : ""}
            {o.material_expiry ? ` · exp ${fmtDate(o.material_expiry)}` : ""}
          </span>
          <span className="flex items-center justify-end gap-2">
            {o.status === "parsed" && <Badge variant="secondary">parsed</Badge>}
            {canEdit && (
            <>
              {assignOptions && assignOptions.length > 0 && (
                <Select
                  size="sm"
                  className="min-w-[12rem]"
                  ariaLabel="Assign to material"
                  placeholder="Assign to material…"
                  value=""
                  disabled={pending}
                  options={assignOptions}
                  onValueChange={(v) => v && run(() => editOrder(o.id, { tenkara_material_id: v }), "Order assigned")}
                />
              )}
              {o.status === "parsed" && (
                <button className="text-green-700 hover:underline" disabled={pending} onClick={() => run(() => confirmOrder(o.id), "Order confirmed")}>
                  confirm
                </button>
              )}
              <button className="text-red-600 hover:underline" disabled={pending} onClick={() => run(() => deleteOrder(o.id), "Order deleted")}>
                delete
              </button>
            </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
