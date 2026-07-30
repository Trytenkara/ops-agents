// Deterministic, operator-facing case-dimension calculator.
//
// Distinct from case-dimensions.ts (the AI estimator that runs at staging-insert
// time): this recomputes OUTER shippable-unit case dimensions ARITHMETICALLY from
// facts an operator can verify (how many units go in a case + each unit's
// dimensions and weight), so ops can override an AI estimate with a value they can
// defend. Framework-free and pure so the client calculator panel and the server
// action share one formula (a single source of truth for the value we persist).
//
// Output maps 1:1 onto the staged_quotes.case_dimensions jsonb shape used by the
// Tenkara CSV export ({unit, width, height, length, packaging_case_weight}); extra
// operator-provenance keys are ignored by that export (it reads only those four).

export type StackAxis = "length" | "width" | "height";
export const STACK_AXES: StackAxis[] = ["length", "width", "height"];
export type CaseType = "Box/Bag" | "Drum" | "Tote";
export const CASE_TYPES: CaseType[] = ["Box/Bag", "Drum", "Tote"];

// Mirrors the case-dimension SOP / marketplace-case-dims lb conversion.
export const LB_TO_KG = 0.453592;

// Provenance value written when an operator saves dimensions from the calculator.
// Kept alongside the existing "supplier" / "ai_estimated" dim_source values.
export const OPERATOR_DIM_SOURCE = "operator_approved";

export interface UnitDims {
  length: number | null; // inches, per single unit
  width: number | null;
  height: number | null;
  weight: number | null; // per single unit, in `weightUnit`
  weightUnit: "kg" | "lb";
}

export interface CaseCalcInput {
  unitsPerCase: number | null;
  unit: UnitDims;
  stackAxis: StackAxis; // the axis the units stack along
}

export interface CaseCalcResult {
  length: number | null; // inches, outer case
  width: number | null;
  height: number | null;
  weight_kg: number | null; // total case weight, kg
  volume_in3: number | null; // outer volume, cubic inches
}

function pos(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// Stacks `unitsPerCase` units along one axis; the other two axes keep the single
// unit's footprint. Total weight = per-unit weight x count (converted to kg).
// Volume is the product of the outer L/W/H (equal to count x unit volume here).
export function computeCaseFromUnits(inp: CaseCalcInput): CaseCalcResult {
  const raw = pos(inp.unitsPerCase);
  const count = raw == null ? 1 : Math.max(1, Math.round(raw));
  const dims: Record<StackAxis, number | null> = {
    length: pos(inp.unit.length),
    width: pos(inp.unit.width),
    height: pos(inp.unit.height),
  };
  const axis: StackAxis = STACK_AXES.includes(inp.stackAxis) ? inp.stackAxis : "height";
  if (dims[axis] != null) dims[axis] = round2((dims[axis] as number) * count);

  const uw = pos(inp.unit.weight);
  const weightKg =
    uw == null
      ? null
      : round3(inp.unit.weightUnit === "lb" ? uw * count * LB_TO_KG : uw * count);

  const volume =
    dims.length != null && dims.width != null && dims.height != null
      ? round2(dims.length * dims.width * dims.height)
      : null;

  return {
    length: dims.length,
    width: dims.width,
    height: dims.height,
    weight_kg: weightKg,
    volume_in3: volume,
  };
}

// Persisted case_dimensions jsonb: the four export keys plus operator provenance
// (so re-opening the calculator pre-fills the inputs). The export ignores the
// extra keys.
export function buildCaseDimensionsJson(inp: CaseCalcInput, res: CaseCalcResult) {
  const raw = pos(inp.unitsPerCase);
  return {
    unit: "in" as const,
    width: res.width,
    height: res.height,
    length: res.length,
    packaging_case_weight: res.weight_kg,
    operator_units_per_case: raw == null ? null : Math.max(1, Math.round(raw)),
    operator_unit_dims: {
      length: pos(inp.unit.length),
      width: pos(inp.unit.width),
      height: pos(inp.unit.height),
      weight: pos(inp.unit.weight),
      weight_unit: inp.unit.weightUnit === "lb" ? "lb" : "kg",
    },
    operator_stack_axis: STACK_AXES.includes(inp.stackAxis) ? inp.stackAxis : "height",
    volume_in3: res.volume_in3,
  };
}
