"use client";
import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { saveCaseDimensions } from "@/app/actions/staged-quotes";
import {
  computeCaseFromUnits,
  CASE_TYPES,
  STACK_AXES,
  type CaseType,
  type StackAxis,
} from "@/lib/case-dims-calc";

// Operator-facing case-dimension calculator. Opens from a "Case dims" button on a
// staged-quote row: the operator enters units-per-case and each unit's
// dimensions/weight, sees the outer case L/W/H, weight, and volume recompute live
// (same pure function the server uses), then approves to persist onto the quote
// with dim_source = operator_approved. Read-only until they save; the quote's
// price/status are never touched here.

export interface CaseDimsInit {
  case_type: string | null;
  case_size: number | null;
  unit_of_measurement: string | null;
  case_dimensions: any | null;
}

function numOrNull(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toStr(n: number | null | undefined): string {
  return n == null ? "" : String(n);
}

function fmt(n: number | null): string {
  return n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function CaseDimsCalculator({
  stagedId,
  init,
  disabled,
}: {
  stagedId: string;
  init: CaseDimsInit;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="Calculate and approve outer case dimensions for the freight quote"
      >
        Case dims
      </Button>
      {open && <CaseDimsModal stagedId={stagedId} init={init} onClose={() => setOpen(false)} />}
    </>
  );
}

function CaseDimsModal({
  stagedId,
  init,
  onClose,
}: {
  stagedId: string;
  init: CaseDimsInit;
  onClose: () => void;
}) {
  const stored = init.case_dimensions ?? {};
  const priorUnit = stored.operator_unit_dims ?? {};

  const [unitsPerCase, setUnitsPerCase] = useState<string>(
    toStr(stored.operator_units_per_case ?? null)
  );
  const [length, setLength] = useState<string>(toStr(priorUnit.length ?? null));
  const [width, setWidth] = useState<string>(toStr(priorUnit.width ?? null));
  const [height, setHeight] = useState<string>(toStr(priorUnit.height ?? null));
  const [weight, setWeight] = useState<string>(toStr(priorUnit.weight ?? null));
  const [weightUnit, setWeightUnit] = useState<"kg" | "lb">(
    priorUnit.weight_unit === "lb" ? "lb" : "kg"
  );
  const [stackAxis, setStackAxis] = useState<StackAxis>(
    STACK_AXES.includes(stored.operator_stack_axis) ? stored.operator_stack_axis : "height"
  );
  const [caseType, setCaseType] = useState<CaseType>(
    CASE_TYPES.includes(init.case_type as CaseType) ? (init.case_type as CaseType) : "Box/Bag"
  );

  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const result = useMemo(
    () =>
      computeCaseFromUnits({
        unitsPerCase: numOrNull(unitsPerCase),
        stackAxis,
        unit: {
          length: numOrNull(length),
          width: numOrNull(width),
          height: numOrNull(height),
          weight: numOrNull(weight),
          weightUnit,
        },
      }),
    [unitsPerCase, length, width, height, weight, weightUnit, stackAxis]
  );

  const hasDims = result.length != null || result.width != null || result.height != null;

  function save() {
    setErr(null);
    startTransition(async () => {
      const res = await saveCaseDimensions(stagedId, {
        unitsPerCase: numOrNull(unitsPerCase),
        length: numOrNull(length),
        width: numOrNull(width),
        height: numOrNull(height),
        weight: numOrNull(weight),
        weightUnit,
        stackAxis,
        caseType,
      });
      if (!res.ok) setErr(res.error ?? "failed");
      else onClose();
    });
  }

  const field =
    "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const label = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-card p-6 text-left shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Case dimensions calculator"
      >
        <div className="space-y-1">
          <h2 className="font-serif text-xl">Case dimensions</h2>
          <p className="text-xs text-muted-foreground">
            Enter how many units ship in a case and each unit&apos;s size and weight. The outer case
            L/W/H, weight, and volume recompute below. Approve to save onto the quote (flagged as
            operator-approved) for the freight calc.
          </p>
          {(init.case_size != null || init.unit_of_measurement) && (
            <p className="text-xs text-muted-foreground">
              Extracted pack size: {fmt(init.case_size)} {init.unit_of_measurement ?? ""}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="col-span-2 sm:col-span-1">
            <label className={label}>Units / case</label>
            <input
              className={field}
              inputMode="numeric"
              value={unitsPerCase}
              onChange={(e) => setUnitsPerCase(e.target.value)}
              placeholder="e.g. 4"
            />
          </div>
          <div>
            <label className={label}>Case type</label>
            <Select
              size="sm"
              value={caseType}
              onValueChange={(v) => setCaseType(v as CaseType)}
              options={CASE_TYPES.map((c) => ({ value: c, label: c }))}
              ariaLabel="Case type"
            />
          </div>
          <div>
            <label className={label}>Stack along</label>
            <Select
              size="sm"
              value={stackAxis}
              onValueChange={(v) => setStackAxis(v as StackAxis)}
              options={STACK_AXES.map((a) => ({ value: a, label: a }))}
              ariaLabel="Stack axis"
            />
          </div>
        </div>

        <div>
          <div className={label + " mb-1"}>Per-unit dimensions (in) and weight</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className={label}>Length</label>
              <input className={field} inputMode="decimal" value={length} onChange={(e) => setLength(e.target.value)} />
            </div>
            <div>
              <label className={label}>Width</label>
              <input className={field} inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} />
            </div>
            <div>
              <label className={label}>Height</label>
              <input className={field} inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} />
            </div>
            <div>
              <label className={label}>Weight</label>
              <div className="flex gap-1">
                <input className={field} inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
                <Select
                  size="sm"
                  className="w-16"
                  value={weightUnit}
                  onValueChange={(v) => setWeightUnit(v as "kg" | "lb")}
                  options={[
                    { value: "kg", label: "kg" },
                    { value: "lb", label: "lb" },
                  ]}
                  ariaLabel="Weight unit"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-md border border-border bg-secondary/40 p-3">
          <div className={label + " mb-2"}>Computed outer case</div>
          <div className="grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <span className="text-muted-foreground">L </span>
              {fmt(result.length)}
            </div>
            <div>
              <span className="text-muted-foreground">W </span>
              {fmt(result.width)}
            </div>
            <div>
              <span className="text-muted-foreground">H </span>
              {fmt(result.height)}
            </div>
            <div>
              <span className="text-muted-foreground">in</span>
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">Weight </span>
              {fmt(result.weight_kg)} kg
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">Volume </span>
              {fmt(result.volume_in3)} in³
            </div>
          </div>
        </div>

        {err && <p className="text-xs text-destructive">{err}</p>}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="default" disabled={pending || !hasDims} onClick={save}>
            {pending ? "Saving…" : "Approve & save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
