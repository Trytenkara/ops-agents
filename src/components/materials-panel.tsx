"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Select, type SelectOption } from "@/components/ui/select";
import type { MaterialProfile, MaterialProfileRow, OrderLineRow } from "@/lib/material-profile";
import { uploadAndParsePO, confirmOrder, deleteOrder, rematchOrders, editOrder } from "@/app/actions/material-profile";

function fmtQty(qty: number | null, unit: string | null): string {
  if (qty == null) return "—";
  return `${qty.toLocaleString()}${unit ? ` ${unit}` : ""}`;
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

export function MaterialsPanel({ orgId, profile, canEdit }: { orgId: string; profile: MaterialProfile; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
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
    <div className="space-y-5 max-w-6xl">
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
          </CardContent>
        </Card>
      )}

      {msg && (
        <p className={msg.kind === "ok" ? "text-xs text-green-700" : "text-xs text-red-600"}>{msg.text}</p>
      )}

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
        <Card className="tb-surface shadow-none">
          <CardHeader>
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Materials</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Material</TableHead>
                  <TableHead>Grade</TableHead>
                  <TableHead>Annual req.</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Avg order</TableHead>
                  <TableHead>Min shelf-life (mat. &amp; COA)</TableHead>
                  <TableHead>Current quote expiry</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.materials.map((m) => (
                  <MaterialRow key={m.tenkaraMaterialId ?? m.label} m={m} canEdit={canEdit} pending={pending} run={run} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
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

function MaterialRow({
  m,
  canEdit,
  pending,
  run,
}: {
  m: MaterialProfileRow;
  canEdit: boolean;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string; parsed?: number }>, okText: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rec = m.recommendedShelfLifeMonths;

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => m.orders.length > 0 && setOpen((o) => !o)}>
        <TableCell className="font-medium">
          {m.label}
          {m.orders.length > 0 && <span className="ml-2 text-xs text-muted-foreground">{open ? "▾" : "▸"} {m.orders.length}</span>}
        </TableCell>
        <TableCell>{m.grade ? <Badge variant="secondary">{m.grade}</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
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
      </TableRow>
      {open && m.orders.length > 0 && (
        <TableRow>
          <TableCell colSpan={7} className="bg-secondary/20">
            <OrderList orders={m.orders} canEdit={canEdit} pending={pending} run={run} />
          </TableCell>
        </TableRow>
      )}
    </>
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
    <div className="space-y-1.5 py-1">
      {orders.map((o) => (
        <div key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground w-24">{fmtDate(o.order_date)}</span>
          {o.material_label && <span className="font-medium">{o.material_label}</span>}
          {o.supplier_name && <span className="text-muted-foreground">{o.supplier_name}</span>}
          <span>ordered {fmtQty(o.ordered_qty, o.qty_unit)}</span>
          {o.po_qty != null && o.po_qty !== o.ordered_qty && <span className="text-muted-foreground">PO {fmtQty(o.po_qty, o.qty_unit)}</span>}
          {o.unit_price != null && <span className="text-muted-foreground">${o.unit_price}/u</span>}
          {o.coa_expiry && <span className="text-muted-foreground">COA exp {fmtDate(o.coa_expiry)}</span>}
          {o.material_expiry && <span className="text-muted-foreground">mat exp {fmtDate(o.material_expiry)}</span>}
          {o.status === "parsed" && <Badge variant="secondary">parsed</Badge>}
          {canEdit && (
            <span className="ml-auto flex items-center gap-2">
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
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
