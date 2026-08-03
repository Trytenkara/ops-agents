"use client";

import { useState, useTransition } from "react";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { saveQuoteProfile } from "@/app/actions/quote-profiles";
import type { QuoteProfile, QuoteProfileUpdate } from "@/lib/quote-profiles";
import { quoteCompleteness } from "@/lib/quote-profiles";

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
  className = "",
}: {
  label: string;
  value: string | number | null;
  field: string;
  editing: boolean;
  onChange: (field: string, value: string) => void;
  type?: string;
  className?: string;
}) {
  if (!editing) {
    return (
      <div className={`space-y-0.5 ${className}`}>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</div>
        <div className="text-sm">{value ?? <span className="text-muted-foreground italic">empty</span>}</div>
      </div>
    );
  }
  return (
    <label className={`space-y-0.5 block ${className}`}>
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

function ReqRow({
  label,
  prefix,
  profile,
  editing,
  onCheck,
  hasDealbreaker = true,
  hasRequestedMet = true,
}: {
  label: string;
  prefix: string;
  profile: QuoteProfile;
  editing: boolean;
  onCheck: (field: string, value: boolean) => void;
  hasDealbreaker?: boolean;
  hasRequestedMet?: boolean;
}) {
  const req = (profile as any)[`${prefix}_required`] as boolean;
  const db = hasDealbreaker ? (profile as any)[`${prefix}_dealbreaker`] as boolean : false;
  const rq = hasRequestedMet ? (profile as any)[`${prefix}_requested`] as boolean : false;
  const met = hasRequestedMet ? (profile as any)[`${prefix}_met`] as boolean : false;

  return (
    <tr className="text-xs">
      <td className="pr-4 py-1 font-medium">{label}</td>
      <td className="px-3 py-1">
        <Checkbox label="" checked={req} field={`${prefix}_required`} editing={editing} onChange={onCheck} />
      </td>
      {hasDealbreaker && (
        <td className="px-3 py-1">
          <Checkbox label="" checked={db} field={`${prefix}_dealbreaker`} editing={editing} onChange={onCheck} />
        </td>
      )}
      {hasRequestedMet && (
        <>
          <td className="px-3 py-1">
            <Checkbox label="" checked={rq} field={`${prefix}_requested`} editing={editing} onChange={onCheck} />
          </td>
          <td className="px-3 py-1">
            <Checkbox label="" checked={met} field={`${prefix}_met`} editing={editing} onChange={onCheck} />
          </td>
        </>
      )}
    </tr>
  );
}

export function QuoteProfileCard({
  profile: initial,
  orgId,
  canAct,
}: {
  profile: QuoteProfile;
  orgId: string;
  canAct: boolean;
}) {
  const [profile, setProfile] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const comp = quoteCompleteness(profile);
  const status = STATUS_META[profile.approval_status] ?? STATUS_META.draft;
  const unitPrice = profile.price != null && profile.case_size && profile.case_size > 0
    ? (profile.price / profile.case_size).toFixed(4)
    : null;

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
      const { id, org_id, created_at, updated_at, ...updates } = profile;
      const res = await saveQuoteProfile(profile.id, orgId, updates as QuoteProfileUpdate);
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
          <div className="flex items-center gap-3 flex-wrap">
            <CardTitle className="text-base">{profile.material_name}</CardTitle>
            <span className="text-xs text-muted-foreground">from {profile.supplier_name}</span>
            {profile.source_url && (
              <a
                href={profile.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                title={profile.source_url}
              >
                Checkout link ↗
              </a>
            )}
            <Badge variant={status.variant}>{status.label}</Badge>
            {profile.is_hazardous && <Badge variant="warn">Hazardous</Badge>}
            {profile.is_refrigerated && <Badge variant="info">Refrigerated</Badge>}
          </div>
          <div className="flex items-center gap-2">
            {canAct && !editing && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>
            )}
            {editing && (
              <>
                <Button variant="outline" size="sm" onClick={() => { setProfile(initial); setEditing(false); }}>Cancel</Button>
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
          {/* Quoting */}
          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">
              Quoting
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Price (USD)" value={profile.price} field="price" editing={editing} onChange={handleNumberChange} type="number" />
              <Field label="Case Size (qty)" value={profile.case_size} field="case_size" editing={editing} onChange={handleNumberChange} type="number" />
            </div>
            {unitPrice && (
              <div className="text-xs text-muted-foreground">Unit price: ${unitPrice}/{profile.unit_of_measurement ?? "unit"}</div>
            )}
            {editing ? (
              <div className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Units</span>
                <Select
                  size="sm"
                  ariaLabel="Unit of measurement"
                  placeholder="Select..."
                  value={profile.unit_of_measurement ?? ""}
                  onValueChange={(v) => handleFieldChange("unit_of_measurement", v)}
                  options={["kg", "lb", "g", "oz", "gal", "L", "unit"].map((u) => ({ value: u, label: u }))}
                />
              </div>
            ) : (
              <Field label="Units" value={profile.unit_of_measurement} field="unit_of_measurement" editing={false} onChange={handleFieldChange} />
            )}
            {editing ? (
              <div className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Case Type</span>
                <Select
                  size="sm"
                  ariaLabel="Case type"
                  placeholder="Select..."
                  value={profile.case_type ?? ""}
                  onValueChange={(v) => handleFieldChange("case_type", v)}
                  options={["Box/Bag", "Drum", "Tote", "Pail", "Bottle", "Supersack"].map((c) => ({ value: c, label: c }))}
                />
              </div>
            ) : (
              <Field label="Case Type" value={profile.case_type} field="case_type" editing={false} onChange={handleFieldChange} />
            )}
            <div className="grid grid-cols-3 gap-2">
              <Field label="Width" value={profile.case_width} field="case_width" editing={editing} onChange={handleNumberChange} type="number" />
              <Field label="Height" value={profile.case_height} field="case_height" editing={editing} onChange={handleNumberChange} type="number" />
              <Field label="Length" value={profile.case_length} field="case_length" editing={editing} onChange={handleNumberChange} type="number" />
            </div>
            <Field label="Case Weight" value={profile.case_weight} field="case_weight" editing={editing} onChange={handleNumberChange} type="number" />
            <Field label="Quote Expiry" value={profile.quote_expiry} field="quote_expiry" editing={editing} onChange={handleFieldChange} type="date" />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Density" value={profile.density} field="density" editing={editing} onChange={handleNumberChange} type="number" />
              {editing ? (
                <div className="space-y-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Density Unit</span>
                  <Select
                    size="sm"
                    ariaLabel="Density unit"
                    value={profile.density_unit ?? "g/ml"}
                    onValueChange={(v) => handleFieldChange("density_unit", v)}
                    options={["g/ml", "g/cm3", "kg/L", "lb/gal"].map((u) => ({ value: u, label: u }))}
                  />
                </div>
              ) : (
                <Field label="Density Unit" value={profile.density != null ? profile.density_unit : null} field="density_unit" editing={false} onChange={handleFieldChange} />
              )}
            </div>
            {!editing && profile.density_source && (
              <div className="text-[10px] text-muted-foreground">
                Density source:{" "}
                {/^https?:\/\//.test(profile.density_source) ? (
                  <a href={profile.density_source} target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                    {profile.density_source}
                  </a>
                ) : (
                  profile.density_source
                )}
              </div>
            )}
            {editing && (
              <Field label="Checkout / Source URL" value={profile.source_url} field="source_url" editing={editing} onChange={handleFieldChange} />
            )}
          </section>

          {/* Lead Time & Inventory */}
          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">
              Lead Time / Inventory
            </h4>
            <Field label="Lead Time (days incl. weekends)" value={profile.lead_time_days} field="lead_time_days" editing={editing} onChange={handleNumberChange} type="number" />
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min Inventory" value={profile.min_inventory} field="min_inventory" editing={editing} onChange={handleNumberChange} type="number" />
              <Field label="Min Inventory Unit" value={profile.min_inventory_unit} field="min_inventory_unit" editing={editing} onChange={handleFieldChange} />
              <Field label="Max Inventory" value={profile.max_inventory} field="max_inventory" editing={editing} onChange={handleNumberChange} type="number" />
              <Field label="Max Inventory Unit" value={profile.max_inventory_unit} field="max_inventory_unit" editing={editing} onChange={handleFieldChange} />
            </div>
            <div className="border-t pt-2 mt-2 space-y-2">
              <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Flags</h5>
              <Checkbox label="Hazardous" checked={profile.is_hazardous} field="is_hazardous" editing={editing} onChange={handleCheckChange} />
              <Checkbox label="Refrigerated" checked={profile.is_refrigerated} field="is_refrigerated" editing={editing} onChange={handleCheckChange} />
              <Checkbox label="Protect from freezing" checked={profile.protect_from_freezing} field="protect_from_freezing" editing={editing} onChange={handleCheckChange} />
            </div>
            <Field label="Material SKU" value={profile.material_sku} field="material_sku" editing={editing} onChange={handleFieldChange} />

            {/* Approval status */}
            <div className="border-t pt-2 mt-2">
              <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Status</h5>
              {editing ? (
                <Select
                  size="sm"
                  ariaLabel="Approval status"
                  value={profile.approval_status}
                  onValueChange={(v) => handleFieldChange("approval_status", v)}
                  options={[
                    { value: "draft", label: "Draft" },
                    { value: "pending_review", label: "Pending Review" },
                    { value: "ready_for_submission", label: "Ready for Submission" },
                    { value: "submitted", label: "Submitted" },
                  ]}
                />
              ) : (
                <Badge variant={status.variant}>{status.label}</Badge>
              )}
            </div>
          </section>

          {/* Qualifying */}
          <section className="space-y-3">
            <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground border-b pb-1">
              Qualifying
            </h4>
            <div className="space-y-2">
              <h5 className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Quick Checks</h5>
              <Checkbox label="Name Match" checked={profile.name_match} field="name_match" editing={editing} onChange={handleCheckChange} />
              <Checkbox label="INCI Match" checked={profile.inci_match} field="inci_match" editing={editing} onChange={handleCheckChange} />
              <div className="flex items-center gap-2">
                <Checkbox label="Grades Match" checked={profile.grades_match} field="grades_match" editing={editing} onChange={handleCheckChange} />
                {profile.grades_match_detail && (
                  <span className="text-xs text-muted-foreground">{profile.grades_match_detail}</span>
                )}
              </div>
              {editing && (
                <Field label="Grades Match Detail" value={profile.grades_match_detail} field="grades_match_detail" editing={editing} onChange={handleFieldChange} />
              )}
              <Field label="Additional Grades" value={profile.additional_grades} field="additional_grades" editing={editing} onChange={handleFieldChange} />
            </div>
          </section>
        </div>

        {/* Pre-Order Requirements */}
        <div className="mt-4 border-t pt-3">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">
            Pre-Order Requirements
          </h4>
          <table className="text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="pr-4 text-left font-medium"></th>
                <th className="px-3 text-left font-medium">Required</th>
                <th className="px-3 text-left font-medium">Dealbreaker</th>
                <th className="px-3 text-left font-medium">Requested</th>
                <th className="px-3 text-left font-medium">Met</th>
              </tr>
            </thead>
            <tbody>
              <ReqRow label="COA" prefix="preorder_coa" profile={profile} editing={editing} onCheck={handleCheckChange} />
              <ReqRow label="SDS" prefix="preorder_sds" profile={profile} editing={editing} onCheck={handleCheckChange} />
              <ReqRow label="TDS" prefix="preorder_tds" profile={profile} editing={editing} onCheck={handleCheckChange} />
              <ReqRow label="Sample" prefix="preorder_sample" profile={profile} editing={editing} onCheck={handleCheckChange} />
            </tbody>
          </table>
        </div>

        {/* Post-Order Requirements */}
        <div className="mt-4 border-t pt-3">
          <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-2">
            Post-Order Requirements
          </h4>
          <table className="text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="pr-4 text-left font-medium"></th>
                <th className="px-3 text-left font-medium">Required</th>
                <th className="px-3 text-left font-medium">Dealbreaker</th>
              </tr>
            </thead>
            <tbody>
              <ReqRow label="COA" prefix="postorder_coa" profile={profile} editing={editing} onCheck={handleCheckChange} hasDealbreaker hasRequestedMet={false} />
              <ReqRow label="SDS" prefix="postorder_sds" profile={profile} editing={editing} onCheck={handleCheckChange} hasDealbreaker hasRequestedMet={false} />
              <ReqRow label="TDS" prefix="postorder_tds" profile={profile} editing={editing} onCheck={handleCheckChange} hasDealbreaker hasRequestedMet={false} />
            </tbody>
          </table>
        </div>

        {/* Notes */}
        {(editing || profile.purchasing_notes || profile.notes) && (
          <div className="mt-4 border-t pt-3 space-y-3">
            {(editing || profile.purchasing_notes) && (
              <div>
                <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1">Purchasing Notes</h4>
                {editing ? (
                  <textarea
                    value={profile.purchasing_notes ?? ""}
                    onChange={(e) => handleFieldChange("purchasing_notes", e.target.value)}
                    rows={2}
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="Enter purchasing notes..."
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{profile.purchasing_notes}</p>
                )}
              </div>
            )}
            {(editing || profile.notes) && (
              <div>
                <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1">Operator Notes</h4>
                {editing ? (
                  <textarea
                    value={profile.notes ?? ""}
                    onChange={(e) => handleFieldChange("notes", e.target.value)}
                    rows={2}
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder="Add notes..."
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{profile.notes}</p>
                )}
              </div>
            )}
            {profile.generated_notes && (
              <div>
                <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground mb-1">Generated Notes</h4>
                <p className="text-sm text-muted-foreground">{profile.generated_notes}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
