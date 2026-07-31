"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import {
  computeCaseFromUnits,
  buildCaseDimensionsJson,
  OPERATOR_DIM_SOURCE,
  CASE_TYPES,
  STACK_AXES,
  type StackAxis,
  type CaseType,
  type CaseCalcInput,
} from "@/lib/case-dims-calc";

interface ActionResult {
  ok: boolean;
  error?: string;
}

const PATH = "/work/review/staged-quotes";

async function assertCanActOnStaged(stagedId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { error: "forbidden" as const };
  }
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("staged_quotes")
    .select("id, org_id, status")
    .eq("id", stagedId)
    .maybeSingle();
  if (!row) return { error: "not_found" as const };
  if (!seesAllOrgs(session)) {
    if (!row.org_id) return { error: "forbidden" as const };
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(row.org_id)) {
      return { error: "forbidden" as const };
    }
  }
  return { session, admin, row };
}

export async function approveStagedQuote(stagedId: string): Promise<ActionResult> {
  const ctx = await assertCanActOnStaged(stagedId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { session, admin } = ctx;
  const { error } = await admin
    .from("staged_quotes")
    .update({
      status: "approved",
      approved_by: session.userId,
      approved_at: new Date().toISOString(),
      dismissed_by: null,
      dismissed_at: null,
    })
    .eq("id", stagedId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export async function dismissStagedQuote(stagedId: string): Promise<ActionResult> {
  const ctx = await assertCanActOnStaged(stagedId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { session, admin } = ctx;
  const { error } = await admin
    .from("staged_quotes")
    .update({
      status: "dismissed",
      dismissed_by: session.userId,
      dismissed_at: new Date().toISOString(),
      approved_by: null,
      approved_at: null,
    })
    .eq("id", stagedId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export async function reopenStagedQuote(stagedId: string): Promise<ActionResult> {
  const ctx = await assertCanActOnStaged(stagedId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { admin } = ctx;
  const { error } = await admin
    .from("staged_quotes")
    .update({
      status: "pending_review",
      approved_by: null,
      approved_at: null,
      dismissed_by: null,
      dismissed_at: null,
    })
    .eq("id", stagedId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export interface CaseDimsSave {
  unitsPerCase: number | null;
  length: number | null; // per-unit, inches
  width: number | null;
  height: number | null;
  weight: number | null; // per-unit
  weightUnit: "kg" | "lb";
  stackAxis: StackAxis;
  caseType: CaseType;
}

// Operator-approved case dimensions from the calculator panel. The stored value
// is RECOMPUTED here from the raw inputs via the shared pure function (single
// source of truth, so the client display and the persisted value can never drift),
// and flagged dim_source = operator_approved. Case-dimension columns only; the
// quote's price/status are untouched.
export async function saveCaseDimensions(
  stagedId: string,
  input: CaseDimsSave
): Promise<ActionResult> {
  const ctx = await assertCanActOnStaged(stagedId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { admin } = ctx;

  if (input.unitsPerCase == null || !Number.isInteger(input.unitsPerCase) || input.unitsPerCase <= 0) {
    return { ok: false, error: "Units per case must be a positive whole number." };
  }
  if (![input.length, input.width, input.height, input.weight].every((value) => value != null && Number.isFinite(value) && value > 0)) {
    return { ok: false, error: "Enter positive length, width, height, and weight values." };
  }
  const axis: StackAxis = STACK_AXES.includes(input.stackAxis) ? input.stackAxis : "height";
  const weightUnit: "kg" | "lb" = input.weightUnit === "lb" ? "lb" : "kg";
  const caseType: CaseType = CASE_TYPES.includes(input.caseType) ? input.caseType : "Box/Bag";
  const calcInput: CaseCalcInput = {
    unitsPerCase: input.unitsPerCase,
    stackAxis: axis,
    unit: {
      length: input.length,
      width: input.width,
      height: input.height,
      weight: input.weight,
      weightUnit,
    },
  };
  const res = computeCaseFromUnits(calcInput);
  if ([res.width, res.height, res.length, res.weight_kg].some((value) => value == null || !Number.isFinite(value) || value <= 0)) {
    return { ok: false, error: "The calculated case dimensions and weight must all be positive." };
  }

  const { error } = await admin
    .from("staged_quotes")
    .update({
      case_type: caseType,
      case_dimensions: buildCaseDimensionsJson(calcInput, res),
      dim_source: OPERATOR_DIM_SOURCE,
    })
    .eq("id", stagedId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}

export interface StagedQuoteEdit {
  supplier_name: string | null;
  material_name: string | null;
  price: number | null;
  case_size: number | null;
  unit_of_measurement: string | null;
  currency: string | null;
}

// Ops cleans the extracted values before approving. unit_price is generated by
// the DB from price/case_size, so we don't set it here.
export async function updateStagedQuote(
  stagedId: string,
  edit: StagedQuoteEdit
): Promise<ActionResult> {
  const ctx = await assertCanActOnStaged(stagedId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { admin } = ctx;
  const num = (v: number | null) => (v == null || Number.isNaN(v) ? null : v);
  const str = (v: string | null) => {
    const t = (v ?? "").trim();
    return t === "" ? null : t;
  };
  const { error } = await admin
    .from("staged_quotes")
    .update({
      supplier_name: str(edit.supplier_name),
      material_name: str(edit.material_name),
      price: num(edit.price),
      case_size: num(edit.case_size),
      unit_of_measurement: str(edit.unit_of_measurement),
      currency: str(edit.currency) ?? "USD",
    })
    .eq("id", stagedId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(PATH);
  return { ok: true };
}
