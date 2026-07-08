"use client";

import { useRef, useState, useTransition } from "react";
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
import type { MaterialSourcingStatus } from "@/lib/material-sourcing-status";
import { uploadAndParsePO, confirmOrder, deleteOrder, rematchOrders, editOrder } from "@/app/actions/material-profile";
import { approveStagedQuote, dismissStagedQuote } from "@/app/actions/staged-quotes";
import { saveSourcingNotes } from "@/app/actions/client-settings";

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
  status: string;
  confidence: string | null;
  created_at: string;
}

export function MaterialsPanel({
  orgId,
  slug,
  profile,
  canEdit,
  statuses,
  quotesByMaterial,
  sourcingNotes,
}: {
  orgId: string;
  slug: string;
  profile: MaterialProfile;
  canEdit: boolean;
  statuses?: Record<string, MaterialSourcingStatus>;
  quotesByMaterial?: Record<string, MaterialQuote[]>;
  sourcingNotes?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [notes, setNotes] = useState(sourcingNotes ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

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
            <Button size="sm" variant="secondary" className="ml-auto" disabled={pending} onClick={() => fileRef.current?.click()}>
              {pending ? "Working…" : "Upload PO"}
            </Button>
            <div className="w-full">
              <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-1">Sourcing notes</div>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={!canEdit || pending}
                rows={2}
                placeholder="Context for sourcing this client — preferred suppliers, constraints, supplier notes…"
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
        return (
          <div className="rounded-lg border border-amber-300/60 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
            <span className="font-medium">{gaps.length} material{gaps.length === 1 ? "" : "s"} need a clearer grade.</span>{" "}
            A missing grade, a bare purity % (e.g. “100% purity”), or an ambiguous code (e.g. “GBB”) doesn&apos;t say which form/type (HCl, base, USP, anhydrous…). Specify it on{" "}
            {gaps.slice(0, 4).map((m) => m.label).join(", ")}
            {gaps.length > 4 ? `, +${gaps.length - 4} more` : ""} so sourcing matches the right product.
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
                {profile.materials.map((m) => (
                  <MaterialRow
                    key={m.tenkaraMaterialId ?? m.label}
                    m={m}
                    canEdit={canEdit}
                    pending={pending}
                    run={run}
                    status={m.tenkaraMaterialId ? statuses?.[m.tenkaraMaterialId] : undefined}
                    quotes={m.tenkaraMaterialId ? quotesByMaterial?.[m.tenkaraMaterialId] ?? [] : []}
                    base={`/work/orgs/${slug}`}
                  />
                ))}
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

function SourcingChip({ status, base }: { status?: MaterialSourcingStatus; base: string }) {
  if (!status) return <span className="text-muted-foreground">—</span>;
  const inner = (
    <span className={cn("inline-flex flex-col rounded-md px-2 py-1 text-left leading-tight", status.cls)}>
      <span className="text-[11px] font-semibold uppercase tracking-wide">{status.label}</span>
      <span className="text-[10px] opacity-80">{status.reason}</span>
    </span>
  );
  return status.tab ? (
    <Link href={`${base}${status.tab}`} onClick={(e) => e.stopPropagation()} className="inline-block hover:opacity-80">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function MaterialRow({
  m,
  canEdit,
  pending,
  run,
  status,
  quotes,
  base,
}: {
  m: MaterialProfileRow;
  canEdit: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string; parsed?: number }>, okText: string) => void;
  status?: MaterialSourcingStatus;
  quotes: MaterialQuote[];
  base: string;
}) {
  const [open, setOpen] = useState(false);
  const rec = m.recommendedShelfLifeMonths;
  const expandable = m.orders.length > 0 || quotes.length > 0;
  const detailCount = quotes.length + m.orders.length;

  return (
    <>
      <TableRow className={expandable ? "cursor-pointer" : ""} onClick={() => expandable && setOpen((o) => !o)}>
        <TableCell className="font-medium">
          {m.label}
          {expandable && <span className="ml-2 text-xs text-muted-foreground">{open ? "▾" : "▸"} {detailCount}</span>}
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
      {open && expandable && (
        <TableRow>
          <TableCell colSpan={9} className="bg-secondary/20">
            <div className="space-y-4 py-1">
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
