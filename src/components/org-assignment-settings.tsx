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
  { value: "auto_all", label: "Auto, reassign all", hint: "The auto spread runs over today's manual assignees (their claims are kept, not deleted, so switching back restores them). Assignments you edit afterwards stick" },
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

interface RebalancePreview {
  poolSize: number;
  claimsCleared: number;
  claimsMoved: number;
  leadsCleared: number;
  leadsMoved: number;
  draftsMoved: number;
  unowned: number;
  projected: { id: string; name: string; suppliers: number }[];
}

export function OrgAssignmentSettings({
  orgId,
  orgSlug,
  orgName,
  initialMode,
  initialSupplierTypes,
  operators,
  canEdit,
  canRebalance,
}: {
  orgId: string;
  orgSlug: string;
  orgName: string;
  initialMode: AssignmentMode;
  initialSupplierTypes: MarketKind[];
  operators: AssignmentOperator[];
  canEdit: boolean;
  canRebalance: boolean;
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
  const [preview, setPreview] = useState<RebalancePreview | null>(null);
  const [rebalancing, setRebalancing] = useState(false);
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

  async function rebalance(dryRun: boolean) {
    setMsg(null);
    setErr(null);
    setRebalancing(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/rebalance-assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun, orgSlug }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data?.error ?? "failed");
        return;
      }
      if (dryRun) {
        setPreview(data);
        return;
      }
      setPreview(null);
      setMsg(
        `Rebalanced across ${data.poolSize} operator${data.poolSize === 1 ? "" : "s"}: ` +
          `${data.claimsCleared + data.claimsMoved} supplier${data.claimsCleared + data.claimsMoved === 1 ? "" : "s"}, ` +
          `${data.leadsCleared + data.leadsMoved} lead${data.leadsCleared + data.leadsMoved === 1 ? "" : "s"}, ` +
          `${data.draftsMoved} thread${data.draftsMoved === 1 ? "" : "s"} moved.`
      );
      router.refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setRebalancing(false);
    }
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

      {canRebalance && (
        <div className="space-y-2 border-t pt-5">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Rebalance across the current operators</div>
          <p className="text-xs text-muted-foreground">
            Re-runs the rules above against today&apos;s operator list, so anyone added since the last run picks up their
            share. Suppliers, leads and email threads all move together. Pinned assignments are released where the rules
            can own them, and spread evenly where they cannot (manual mode, or a type outside the auto loop).
          </p>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" disabled={rebalancing || operators.length === 0} onClick={() => rebalance(true)}>
              {rebalancing && !preview ? "Checking..." : "Preview rebalance"}
            </Button>
            {preview && (
              <Button size="sm" variant="destructive" disabled={rebalancing} onClick={() => rebalance(false)}>
                {rebalancing ? "Rebalancing..." : "Apply rebalance"}
              </Button>
            )}
          </div>
          {operators.length === 0 && (
            <p className="text-xs text-muted-foreground">Add operators to this org first, there is nobody to rebalance onto.</p>
          )}
          {preview && (
            <div className="space-y-1 rounded-md border p-3">
              <p className="text-xs">
                Moves {preview.claimsCleared + preview.claimsMoved} supplier
                {preview.claimsCleared + preview.claimsMoved === 1 ? "" : "s"},{" "}
                {preview.leadsCleared + preview.leadsMoved} lead{preview.leadsCleared + preview.leadsMoved === 1 ? "" : "s"} and{" "}
                {preview.draftsMoved} email thread{preview.draftsMoved === 1 ? "" : "s"} across {preview.poolSize} operator
                {preview.poolSize === 1 ? "" : "s"}.
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {preview.projected.map((p) => (
                  <span key={p.id}>
                    {p.name} {p.suppliers}
                  </span>
                ))}
                {preview.unowned > 0 && <span>unassigned {preview.unowned}</span>}
              </div>
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Reassigned threads are mirrored to the Tenkara inbox, so operators lose conversations they have already
                emailed on. Released pins cannot be restored by switching modes back.
              </p>
            </div>
          )}
        </div>
      )}

      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}
