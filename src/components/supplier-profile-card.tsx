"use client";

import { useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { saveSupplierProfile } from "@/app/actions/supplier-profiles";
import { SupplierMarketplaceLogins, type MarketplaceAccount } from "@/components/marketplace-logins";
import type { SupplierProfile, SupplierProfileUpdate } from "@/lib/supplier-profiles";
import { profileCompleteness } from "@/lib/supplier-profiles";

const STATUS_META: Record<string, { label: string; variant: "success" | "warn" | "secondary" }> = {
  draft: { label: "Draft", variant: "secondary" },
  pending_review: { label: "Pending Review", variant: "warn" },
  ready_for_submission: { label: "Ready", variant: "success" },
  submitted: { label: "Submitted", variant: "success" },
};

function Field({
  label,
  value,
  field,
  editing,
  onChange,
  type = "text",
}: {
  label: string;
  value: string | number | null;
  field: string;
  editing: boolean;
  onChange: (field: string, value: string) => void;
  type?: string;
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
      <Input
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(field, e.target.value)}
        className="h-7 text-sm"
      />
    </label>
  );
}

function Checkbox({
  label,
  checked,
  field,
  editing,
  onChange,
}: {
  label: string;
  checked: boolean;
  field: string;
  editing: boolean;
  onChange: (field: string, value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={!editing}
        onChange={(e) => onChange(field, e.target.checked)}
        className="rounded border-gray-300"
      />
      <span className={checked ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>
        {label}
      </span>
    </label>
  );
}

function CompletenessBar({ pct }: { pct: number }) {
  const color = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 bg-secondary rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
    </div>
  );
}

export function SupplierProfileCard({
  profile: initial,
  orgId,
  leadCount,
  canAct,
  tenkara,
  marketplaceAccounts = [],
}: {
  profile: SupplierProfile;
  orgId: string;
  leadCount: number;
  canAct: boolean;
  tenkara?: { approval: string; qualified: boolean } | null;
  marketplaceAccounts?: MarketplaceAccount[];
}) {
  const [profile, setProfile] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const comp = profileCompleteness(profile);
  const status = STATUS_META[profile.approval_status] ?? STATUS_META.draft;

  function handleFieldChange(field: string, value: string) {
    setProfile((p) => ({ ...p, [field]: value || null }));
  }

  function handleNumberChange(field: string, value: string) {
    setProfile((p) => ({ ...p, [field]: value ? Number(value) : null }));
  }

  function handleCheckChange(field: string, value: boolean) {
    setProfile((p) => ({ ...p, [field]: value }));
  }

  function handleSave() {
    startTransition(async () => {
      const updates: SupplierProfileUpdate = {
        supplier_type: profile.supplier_type,
        poc_email: profile.poc_email,
        poc_phone: profile.poc_phone,
        poc_name: profile.poc_name,
        shipping_address: profile.shipping_address,
        shipping_terms: profile.shipping_terms,
        shipping_email: profile.shipping_email,
        ddp_can_book: profile.ddp_can_book,
        ddp_min_limit: profile.ddp_min_limit,
        ddp_max_limit: profile.ddp_max_limit,
        billing_email: profile.billing_email,
        billing_poc_name: profile.billing_poc_name,
        payment_upfront_pct: profile.payment_upfront_pct,
        payment_net_days: profile.payment_net_days,
        payment_completion: profile.payment_completion,
        payment_credit_line: profile.payment_credit_line,
        hazmat_handling_fee: profile.hazmat_handling_fee,
        temp_storage_fee: profile.temp_storage_fee,
        liftgate_fee: profile.liftgate_fee,
        special_packaging_fee: profile.special_packaging_fee,
        contact_info_complete: profile.contact_info_complete,
        marketplace_type_correct: profile.marketplace_type_correct,
        address_accurate: profile.address_accurate,
        shipping_terms_correct: profile.shipping_terms_correct,
        billing_verified: profile.billing_verified,
        payment_info_verified: profile.payment_info_verified,
        payment_terms_confirmed: profile.payment_terms_confirmed,
        notes: profile.notes,
        approval_status: profile.approval_status,
      };
      const res = await saveSupplierProfile(profile.id, orgId, updates);
      if (res.ok) {
        setEditing(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CardTitle className="text-base">{profile.supplier_name}</CardTitle>
            {profile.supplier_type && (
              <Badge variant="secondary">{profile.supplier_type}</Badge>
            )}
            <Badge variant={status.variant}>{status.label}</Badge>
            {tenkara && (
              <Badge variant={tenkara.approval === "approved" ? "success" : "secondary"}>
                Platform: {tenkara.approval}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{leadCount} lead{leadCount !== 1 ? "s" : ""}</span>
            {canAct && !editing && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {editing && (
              <>
                <Button variant="outline" size="sm" onClick={() => { setProfile(initial); setEditing(false); }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={pending}>
                  {pending ? "Saving..." : "Save"}
                </Button>
              </>
            )}
            {saved && <span className="text-xs text-green-600">Saved</span>}
          </div>
        </div>
        <CompletenessBar pct={comp.pct} />
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Contact */}
          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">
              Contact
            </h4>
            <Field label="POC Email" value={profile.poc_email} field="poc_email" editing={editing} onChange={handleFieldChange} />
            <Field label="POC Phone" value={profile.poc_phone} field="poc_phone" editing={editing} onChange={handleFieldChange} />
            <Field label="POC Name" value={profile.poc_name} field="poc_name" editing={editing} onChange={handleFieldChange} />
            {editing && (
              <div className="pt-1">
                <label className="space-y-0.5 block">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Type</span>
                  <select
                    value={profile.supplier_type ?? ""}
                    onChange={(e) => handleFieldChange("supplier_type", e.target.value)}
                    className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="">Select...</option>
                    <option value="marketplace">Marketplace</option>
                    <option value="direct">Direct</option>
                  </select>
                </label>
              </div>
            )}
            <Checkbox label="Contact information complete" checked={profile.contact_info_complete} field="contact_info_complete" editing={editing} onChange={handleCheckChange} />
            <Checkbox label="Marketplace vs Non-Marketplace correctly set" checked={profile.marketplace_type_correct} field="marketplace_type_correct" editing={editing} onChange={handleCheckChange} />
          </section>

          {/* Shipping */}
          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">
              Shipping
            </h4>
            <Field label="Address" value={profile.shipping_address} field="shipping_address" editing={editing} onChange={handleFieldChange} />
            <Field label="Shipping Terms" value={profile.shipping_terms} field="shipping_terms" editing={editing} onChange={handleFieldChange} />
            <Field label="Shipping Email" value={profile.shipping_email} field="shipping_email" editing={editing} onChange={handleFieldChange} />
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-0.5">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">DDP Book</div>
                {editing ? (
                  <select
                    value={profile.ddp_can_book ? "yes" : "no"}
                    onChange={(e) => handleCheckChange("ddp_can_book", e.target.value === "yes")}
                    className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                ) : (
                  <div className="text-sm">{profile.ddp_can_book ? "Yes" : "No"}</div>
                )}
              </div>
              <Field label="DDP Min" value={profile.ddp_min_limit} field="ddp_min_limit" editing={editing} onChange={handleNumberChange} type="number" />
              <Field label="DDP Max" value={profile.ddp_max_limit} field="ddp_max_limit" editing={editing} onChange={handleNumberChange} type="number" />
            </div>
            <Checkbox label="Address accurate US based location" checked={profile.address_accurate} field="address_accurate" editing={editing} onChange={handleCheckChange} />
            <Checkbox label="Shipping terms correct" checked={profile.shipping_terms_correct} field="shipping_terms_correct" editing={editing} onChange={handleCheckChange} />
          </section>

          {/* Billing & Payment */}
          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">
              Billing / Payment
            </h4>
            <Field label="Billing Email" value={profile.billing_email} field="billing_email" editing={editing} onChange={handleFieldChange} />
            <Field label="Billing POC Name" value={profile.billing_poc_name} field="billing_poc_name" editing={editing} onChange={handleFieldChange} />
            <Checkbox label="Billing information verified" checked={profile.billing_verified} field="billing_verified" editing={editing} onChange={handleCheckChange} />
            <div className="border-t pt-2 mt-2">
              <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Payment Terms</h5>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Upfront %" value={profile.payment_upfront_pct} field="payment_upfront_pct" editing={editing} onChange={handleNumberChange} type="number" />
                <Field label="Net Days" value={profile.payment_net_days} field="payment_net_days" editing={editing} onChange={handleNumberChange} type="number" />
                <Field label="Completion" value={profile.payment_completion} field="payment_completion" editing={editing} onChange={handleFieldChange} />
                <Field label="Credit Line" value={profile.payment_credit_line} field="payment_credit_line" editing={editing} onChange={handleFieldChange} />
              </div>
            </div>
            <Checkbox label="Payment information verified" checked={profile.payment_info_verified} field="payment_info_verified" editing={editing} onChange={handleCheckChange} />
            <Checkbox label="Payment terms confirmed per org" checked={profile.payment_terms_confirmed} field="payment_terms_confirmed" editing={editing} onChange={handleCheckChange} />
          </section>
        </div>

        {/* Accessorial Charges */}
        <div className="mt-4 border-t pt-3">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">
            Accessorial Charges
          </h4>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Hazmat Handling" value={profile.hazmat_handling_fee} field="hazmat_handling_fee" editing={editing} onChange={handleNumberChange} type="number" />
            <Field label="Temp Storage" value={profile.temp_storage_fee} field="temp_storage_fee" editing={editing} onChange={handleNumberChange} type="number" />
            <Field label="Liftgate" value={profile.liftgate_fee} field="liftgate_fee" editing={editing} onChange={handleNumberChange} type="number" />
            <Field label="Special Packaging" value={profile.special_packaging_fee} field="special_packaging_fee" editing={editing} onChange={handleNumberChange} type="number" />
          </div>
        </div>

        {/* Notes */}
        {(editing || profile.notes) && (
          <div className="mt-4 border-t pt-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">Operator Notes</h4>
            {editing ? (
              <textarea
                value={profile.notes ?? ""}
                onChange={(e) => handleFieldChange("notes", e.target.value)}
                rows={2}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="Add notes..."
              />
            ) : (
              <p className="text-sm text-muted-foreground">{profile.notes}</p>
            )}
          </div>
        )}
        {/* Where the supplier is a marketplace, ops needs the account it takes to
            see gated pricing — several per site is normal (a buyer seat, a
            reseller login), each tagged with who created it. */}
        {profile.supplier_type === "marketplace" && (
          <SupplierMarketplaceLogins
            accounts={marketplaceAccounts}
            orgId={orgId}
            supplierProfileId={profile.id}
            canAct={canAct}
          />
        )}
        {profile.generated_notes && (
          <div className="mt-4 border-t pt-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">Generated Notes</h4>
            <p className="text-sm text-muted-foreground">{profile.generated_notes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
