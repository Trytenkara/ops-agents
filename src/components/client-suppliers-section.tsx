"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useListFilter, byString } from "@/components/use-list-filter";
import { useState, useTransition } from "react";
import type { ClientSuppliers, ClientSupplier, SupplierApproval } from "@/lib/client-suppliers";
import type { SupplierProfile, SupplierProfileUpdate } from "@/lib/supplier-profiles";
import { profileCompleteness } from "@/lib/supplier-profiles";
import { SupplierOperatorAssign } from "@/components/supplier-operator-assign";
import { TemplateDownloadButton } from "@/components/template-download-button";
import { SUPPLIER_TEMPLATE_HEADERS } from "@/lib/tenkara-templates";
import { saveSupplierProfile, createSupplierProfile } from "@/app/actions/supplier-profiles";

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

function Field({
  label, value, field, editing, onChange, type = "text",
}: {
  label: string; value: string | number | null; field: string; editing: boolean;
  onChange: (field: string, value: string) => void; type?: string;
}) {
  if (!editing) {
    return (
      <div className="space-y-0.5">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</div>
        <div className="text-sm">{value ?? <span className="text-muted-foreground italic">empty</span>}</div>
      </div>
    );
  }
  return (
    <label className="space-y-0.5 block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
      <Input type={type} value={value ?? ""} onChange={(e) => onChange(field, e.target.value)} className="h-7 text-sm" />
    </label>
  );
}

function Check({
  label, checked, field, editing, onChange,
}: {
  label: string; checked: boolean; field: string; editing: boolean;
  onChange: (field: string, value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={checked} disabled={!editing} onChange={(e) => onChange(field, e.target.checked)} className="rounded border-gray-300" />
      <span className={checked ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>{label}</span>
    </label>
  );
}

function SupplierExpanded({
  profile: initial,
  orgId,
  canAct,
}: {
  profile: SupplierProfile;
  orgId: string;
  canAct: boolean;
}) {
  const [p, setP] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const set = (field: string, value: string) => setP((prev) => ({ ...prev, [field]: value || null }));
  const setNum = (field: string, value: string) => setP((prev) => ({ ...prev, [field]: value ? Number(value) : null }));
  const setBool = (field: string, value: boolean) => setP((prev) => ({ ...prev, [field]: value }));

  function handleSave() {
    startTransition(async () => {
      const updates: SupplierProfileUpdate = {
        supplier_type: p.supplier_type,
        poc_email: p.poc_email, poc_phone: p.poc_phone, poc_name: p.poc_name,
        shipping_address: p.shipping_address, shipping_terms: p.shipping_terms, shipping_email: p.shipping_email,
        ddp_can_book: p.ddp_can_book, ddp_min_limit: p.ddp_min_limit, ddp_max_limit: p.ddp_max_limit,
        billing_email: p.billing_email, billing_poc_name: p.billing_poc_name,
        payment_upfront_pct: p.payment_upfront_pct, payment_net_days: p.payment_net_days,
        payment_completion: p.payment_completion, payment_credit_line: p.payment_credit_line,
        hazmat_handling_fee: p.hazmat_handling_fee, temp_storage_fee: p.temp_storage_fee,
        liftgate_fee: p.liftgate_fee, special_packaging_fee: p.special_packaging_fee,
        contact_info_complete: p.contact_info_complete, marketplace_type_correct: p.marketplace_type_correct,
        address_accurate: p.address_accurate, shipping_terms_correct: p.shipping_terms_correct,
        billing_verified: p.billing_verified, payment_info_verified: p.payment_info_verified,
        payment_terms_confirmed: p.payment_terms_confirmed,
        notes: p.notes, approval_status: p.approval_status,
      };
      const res = await saveSupplierProfile(p.id, orgId, updates);
      if (res.ok) { setEditing(false); setSaved(true); setTimeout(() => setSaved(false), 2000); }
    });
  }

  const comp = profileCompleteness(p);

  return (
    <div className="bg-muted/30 border-t px-6 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">Approval completeness</span>
          <div className="flex items-center gap-2 w-32">
            <div className="h-1.5 flex-1 bg-secondary rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${comp.pct >= 80 ? "bg-green-500" : comp.pct >= 50 ? "bg-yellow-500" : "bg-red-400"}`} style={{ width: `${comp.pct}%` }} />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{comp.pct}%</span>
          </div>
          <span className="text-xs text-muted-foreground">{comp.checked}/{comp.checkTotal} checks</span>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-green-600">Saved</span>}
          {canAct && !editing && <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>}
          {editing && (
            <>
              <Button variant="outline" size="sm" onClick={() => { setP(initial); setEditing(false); }}>Cancel</Button>
              <Button size="sm" onClick={handleSave} disabled={pending}>{pending ? "Saving..." : "Save"}</Button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Contact */}
        <section className="space-y-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">Contact</h4>
          <Field label="POC Email" value={p.poc_email} field="poc_email" editing={editing} onChange={set} />
          <Field label="POC Phone" value={p.poc_phone} field="poc_phone" editing={editing} onChange={set} />
          <Field label="POC Name" value={p.poc_name} field="poc_name" editing={editing} onChange={set} />
          {editing && (
            <label className="space-y-0.5 block">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Type</span>
              <select value={p.supplier_type ?? ""} onChange={(e) => set("supplier_type", e.target.value)}
                className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-sm">
                <option value="">Select...</option>
                <option value="marketplace">Marketplace</option>
                <option value="direct">Direct</option>
              </select>
            </label>
          )}
          {!editing && (
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Type</div>
              <div className="text-sm">{p.supplier_type ?? <span className="text-muted-foreground italic">empty</span>}</div>
            </div>
          )}
          <Check label="Contact information complete" checked={p.contact_info_complete} field="contact_info_complete" editing={editing} onChange={setBool} />
          <Check label="Marketplace vs Non-Marketplace correct" checked={p.marketplace_type_correct} field="marketplace_type_correct" editing={editing} onChange={setBool} />
        </section>

        {/* Shipping */}
        <section className="space-y-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">Shipping</h4>
          <Field label="Address" value={p.shipping_address} field="shipping_address" editing={editing} onChange={set} />
          <Field label="Shipping Terms" value={p.shipping_terms} field="shipping_terms" editing={editing} onChange={set} />
          <Field label="Shipping Email" value={p.shipping_email} field="shipping_email" editing={editing} onChange={set} />
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">DDP Book</div>
              {editing ? (
                <select value={p.ddp_can_book ? "yes" : "no"} onChange={(e) => setBool("ddp_can_book", e.target.value === "yes")}
                  className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-sm">
                  <option value="no">No</option><option value="yes">Yes</option>
                </select>
              ) : <div className="text-sm">{p.ddp_can_book ? "Yes" : "No"}</div>}
            </div>
            <Field label="DDP Min" value={p.ddp_min_limit} field="ddp_min_limit" editing={editing} onChange={setNum} type="number" />
            <Field label="DDP Max" value={p.ddp_max_limit} field="ddp_max_limit" editing={editing} onChange={setNum} type="number" />
          </div>
          <Check label="Address accurate US based" checked={p.address_accurate} field="address_accurate" editing={editing} onChange={setBool} />
          <Check label="Shipping terms correct" checked={p.shipping_terms_correct} field="shipping_terms_correct" editing={editing} onChange={setBool} />
        </section>

        {/* Billing & Payment */}
        <section className="space-y-2">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">Billing / Payment</h4>
          <Field label="Billing Email" value={p.billing_email} field="billing_email" editing={editing} onChange={set} />
          <Field label="Billing POC Name" value={p.billing_poc_name} field="billing_poc_name" editing={editing} onChange={set} />
          <Check label="Billing information verified" checked={p.billing_verified} field="billing_verified" editing={editing} onChange={setBool} />
          <div className="border-t pt-2 mt-1">
            <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Payment Terms</h5>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Upfront %" value={p.payment_upfront_pct} field="payment_upfront_pct" editing={editing} onChange={setNum} type="number" />
              <Field label="Net Days" value={p.payment_net_days} field="payment_net_days" editing={editing} onChange={setNum} type="number" />
              <Field label="Completion" value={p.payment_completion} field="payment_completion" editing={editing} onChange={set} />
              <Field label="Credit Line" value={p.payment_credit_line} field="payment_credit_line" editing={editing} onChange={set} />
            </div>
          </div>
          <Check label="Payment info verified" checked={p.payment_info_verified} field="payment_info_verified" editing={editing} onChange={setBool} />
          <Check label="Payment terms confirmed" checked={p.payment_terms_confirmed} field="payment_terms_confirmed" editing={editing} onChange={setBool} />
        </section>
      </div>

      {/* Accessorial charges */}
      <div className="border-t pt-3">
        <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">Accessorial Charges</h4>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Hazmat Handling" value={p.hazmat_handling_fee} field="hazmat_handling_fee" editing={editing} onChange={setNum} type="number" />
          <Field label="Temp Storage" value={p.temp_storage_fee} field="temp_storage_fee" editing={editing} onChange={setNum} type="number" />
          <Field label="Liftgate" value={p.liftgate_fee} field="liftgate_fee" editing={editing} onChange={setNum} type="number" />
          <Field label="Special Packaging" value={p.special_packaging_fee} field="special_packaging_fee" editing={editing} onChange={setNum} type="number" />
        </div>
      </div>

      {/* Notes */}
      <div className="border-t pt-3">
        <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">Notes</h4>
        {editing ? (
          <textarea value={p.notes ?? ""} onChange={(e) => set("notes", e.target.value)} rows={2}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="Add notes..." />
        ) : (
          <p className="text-sm text-muted-foreground">{p.notes || "No notes"}</p>
        )}
      </div>
    </div>
  );
}

export function ClientSuppliersSection({
  suppliers,
  orgId,
  autoNames,
  assignments,
  operatorOptions,
  operatorNames,
  canAct,
  profiles,
}: {
  suppliers: ClientSuppliers;
  orgId: string;
  autoNames?: Record<string, string>;
  assignments?: Record<string, string>;
  operatorOptions?: { id: string; name: string }[];
  operatorNames?: Record<string, string>;
  canAct?: boolean;
  profiles?: Record<string, SupplierProfile>;
}) {
  const all: ClientSupplier[] = [
    ...suppliers.approved,
    ...suppliers.pending_review,
    ...suppliers.denied,
    ...suppliers.draft,
  ];
  const [status, setStatus] = useState<string>("all");
  const statusRows = status === "all" ? all : all.filter((s) => s.approval === status);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [creating, startCreate] = useTransition();

  const { filtered, controls } = useListFilter(statusRows, {
    searchText: (r) => `${r.name ?? ""} ${r.poc_email ?? ""} ${r.poc_name ?? ""}`,
    searchPlaceholder: "supplier or email…",
    sorts: [
      { value: "status", label: "Status", compare: (a, b) => STATUS_ORDER[a.approval] - STATUS_ORDER[b.approval] || (a.name ?? "").localeCompare(b.name ?? "") },
      { value: "name", label: "Supplier (A–Z)", compare: byString((r: ClientSupplier) => r.name) },
    ],
    defaultSort: "status",
  });

  function handleRowClick(s: ClientSupplier) {
    if (expandedId === s.id) {
      setExpandedId(null);
      return;
    }
    if (profiles?.[s.id]) {
      setExpandedId(s.id);
      return;
    }
    startCreate(async () => {
      await createSupplierProfile(orgId, s.id, s.name ?? "Unknown", {
        supplier_type: s.is_marketplace ? "marketplace" : "direct",
        poc_email: s.poc_email,
        poc_name: s.poc_name,
      });
      setExpandedId(s.id);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Suppliers</h3>
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
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-6"></TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Qualified</TableHead>
                    <TableHead>Operator</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Completeness</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((s) => {
                    const isExpanded = expandedId === s.id;
                    const profile = profiles?.[s.id];
                    const comp = profile ? profileCompleteness(profile) : null;
                    return (
                      <TableRow key={s.id} className="group" data-state={isExpanded ? "expanded" : undefined}>
                        <TableCell>
                          <button
                            onClick={() => handleRowClick(s)}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            disabled={creating}
                          >
                            <svg className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        </TableCell>
                        <TableCell className="font-medium cursor-pointer" onClick={() => handleRowClick(s)}>
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
                            />
                          ) : assignments?.[s.id] ? (
                            <Badge variant="outline">{operatorNames?.[assignments[s.id]] ?? "Assigned"}</Badge>
                          ) : autoNames?.[s.id] ? (
                            <Badge variant="outline">{autoNames[s.id]} <span className="text-muted-foreground">(auto)</span></Badge>
                          ) : (
                            <span className="italic text-muted-foreground">Unassigned</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs">{s.poc_email ?? s.poc_name ?? "—"}</TableCell>
                        <TableCell>
                          {comp ? (
                            <div className="flex items-center gap-2 w-20">
                              <div className="h-1.5 flex-1 bg-secondary rounded-full overflow-hidden">
                                <div className={`h-full rounded-full ${comp.pct >= 80 ? "bg-green-500" : comp.pct >= 50 ? "bg-yellow-500" : "bg-red-400"}`} style={{ width: `${comp.pct}%` }} />
                              </div>
                              <span className="text-xs text-muted-foreground tabular-nums">{comp.pct}%</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">click to load</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-xs max-w-xs truncate" title={s.approval_notes ?? undefined}>
                          {s.approval_notes ?? "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filtered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground py-8">No suppliers match.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              {/* Expanded detail panel renders outside the table to avoid nesting issues */}
              {expandedId && profiles?.[expandedId] && (
                <SupplierExpanded profile={profiles[expandedId]} orgId={orgId} canAct={canAct ?? false} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
