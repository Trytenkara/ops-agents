"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { setOrgAssignmentSettings, setOperatorAutoAssignable } from "@/app/actions/assignment-settings";
import type { AssignmentMode } from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";

const MODES: { value: AssignmentMode; label: string; hint: string }[] = [
  { value: "manual", label: "Manual", hint: "Nobody is auto-assigned. Current assignees are pinned as they are today, and new suppliers land unassigned until someone claims them" },
  { value: "auto_new", label: "Auto, new only", hint: "Existing assignees keep their suppliers; only suppliers nobody has claimed get spread across the auto loop" },
  { value: "auto_all", label: "Auto, reassign all", hint: "The auto spread wins everywhere and overrides manual assignees (the claims are kept, not deleted, so switching back restores them)" },
];

const TYPES: { value: MarketKind; label: string }[] = [
  { value: "marketplace", label: "Marketplaces" },
  { value: "aggregator", label: "Aggregators" },
  { value: "direct", label: "Direct / NMP" },
];

export interface AssignmentOperator {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  autoAssignable: boolean;
}

export function OrgAssignmentSettings({
  orgId,
  orgSlug,
  orgName,
  initialMode,
  initialSupplierTypes,
  operators,
  canEdit,
}: {
  orgId: string;
  orgSlug: string;
  orgName: string;
  initialMode: AssignmentMode;
  initialSupplierTypes: MarketKind[];
  operators: AssignmentOperator[];
  canEdit: boolean;
}) {
  const [savedMode, setSavedMode] = useState(initialMode);
  const [savedTypes, setSavedTypes] = useState(initialSupplierTypes);
  const [mode, setMode] = useState(initialMode);
  const [types, setTypes] = useState(initialSupplierTypes);
  const [excluded, setExcluded] = useState<Set<string>>(
    () => new Set(operators.filter((o) => !o.autoAssignable).map((o) => o.id))
  );
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const dirty = mode !== savedMode || types.length !== savedTypes.length || types.some((t) => !savedTypes.includes(t));
  const autoOn = savedMode !== "manual";
  const inLoop = operators.filter((o) => !excluded.has(o.id));

  function save() {
    setMsg(null);
    setErr(null);
    start(async () => {
      const res = await setOrgAssignmentSettings({ orgId, orgSlug, mode, supplierTypes: types });
      if (!res.ok) {
        setErr(res.error ?? "failed");
        setMode(savedMode);
        setTypes(savedTypes);
        return;
      }
      setSavedMode(mode);
      setSavedTypes(types);
      setMsg(res.frozen ? `Saved. Pinned ${res.frozen} current assignee${res.frozen === 1 ? "" : "s"} so nothing moved.` : "Saved.");
      router.refresh();
    });
  }

  function toggleOperator(userId: string, next: boolean) {
    setErr(null);
    const optimistic = new Set(excluded);
    if (next) optimistic.delete(userId);
    else optimistic.add(userId);
    setExcluded(optimistic);
    start(async () => {
      const res = await setOperatorAutoAssignable({ orgId, orgSlug, userId, autoAssignable: next });
      if (!res.ok) {
        setErr(res.error ?? "failed");
        setExcluded(new Set(excluded));
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-5 text-sm">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Badge variant={savedMode === "manual" ? "outline" : savedMode === "auto_new" ? "default" : "warn"}>
            {MODES.find((m) => m.value === savedMode)!.label}
          </Badge>
          {canEdit ? (
            <div className="min-w-[220px]">
              <Select
                value={mode}
                onValueChange={(v) => setMode(v as AssignmentMode)}
                ariaLabel={`Assignment mode for ${orgName}`}
                options={MODES.map((m) => ({ value: m.value, label: m.label }))}
              />
            </div>
          ) : null}
          {canEdit && dirty && (
            <Button size="sm" disabled={pending} onClick={save}>
              {pending ? "Saving..." : "Save"}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{MODES.find((m) => m.value === mode)!.hint}.</p>
        {mode === "manual" && savedMode !== "manual" && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Saving pins every current assignee (suppliers and leads) so the switch changes nothing visible.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Supplier types in the auto loop</div>
        <div className="flex flex-wrap items-center gap-4">
          {TYPES.map((t) => {
            const on = types.includes(t.value);
            return (
              <label key={t.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={on}
                  disabled={!canEdit || pending}
                  onChange={() => setTypes(on ? types.filter((x) => x !== t.value) : [...types, t.value])}
                />
                <span className={on ? "" : "text-muted-foreground"}>{t.label}</span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          {types.length === 0
            ? "Nothing is auto-assigned while every type is off."
            : `Auto only touches ${types.map((t) => TYPES.find((x) => x.value === t)!.label.toLowerCase()).join(", ")}. Other suppliers stay with whoever claims them.`}
        </p>
      </div>

      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Operators in the auto loop</div>
        {operators.length === 0 ? (
          <p className="text-xs text-muted-foreground">No operators are assigned to this org yet.</p>
        ) : (
          <div className="space-y-1">
            {operators.map((o) => {
              const on = !excluded.has(o.id);
              return (
                <label key={o.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={on}
                    disabled={!canEdit || pending}
                    onChange={(e) => toggleOperator(o.id, e.target.checked)}
                  />
                  <span className={on ? "" : "text-muted-foreground line-through"}>{o.name}</span>
                  {o.role && <span className="text-xs text-muted-foreground">{o.role === "ops_lead" ? "lead operator" : "operator"}</span>}
                  {!on && <span className="text-xs text-muted-foreground">(manual only)</span>}
                </label>
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Excluded operators stay on the org and can still be assigned by hand, they just never get picked automatically.
          {autoOn ? ` ${inLoop.length} of ${operators.length} in the loop.` : " Auto is off, so this applies once it is turned on."}
        </p>
      </div>

      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
