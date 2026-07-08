import type { SupabaseClient } from "@supabase/supabase-js";

// Sticky-random operator assignment. A supplier is always owned by the SAME
// operator within an org (so the supplier sees one point of contact), but
// suppliers are spread across the org's operators. We hash the supplier id into
// the org's operator pool — deterministic (stable per supplier, survives
// re-runs, no storage/races) yet evenly distributed.

export interface OperatorRef {
  id: string;
  name: string;
  email: string | null;
}

// FNV-1a — small, stable, well-distributed string hash.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pickSupplierOperator<T extends { id: string }>(
  pool: T[],
  supplierId: string | null | undefined
): T | null {
  if (pool.length === 0) return null;
  if (!supplierId) return pool[0];
  return pool[hashStr(supplierId) % pool.length];
}

// The operators an org's suppliers can be assigned to: everyone explicitly
// assigned to the org (user_org_assignments), minus anyone out of office.
// Falls back to the org's default primary/backup operators when no one is
// explicitly assigned. Sorted by id so the pool order is stable across runs.
export async function getOrgOperatorPool(
  admin: SupabaseClient,
  orgId: string
): Promise<OperatorRef[]> {
  // Assignable operators = ops_operator OR ops_lead (leads run sourcing for
  // clients too). Admins/monitors/account_managers are not assignable. When no
  // eligible operators are assigned to an org, the pool is empty and suppliers
  // stay unassigned (by design, until the ops team is added).
  const ASSIGNABLE = new Set(["ops_operator", "ops_lead"]);
  const isOperator = (u: any): boolean =>
    Array.isArray(u?.user_roles) && u.user_roles.some((r: any) => ASSIGNABLE.has(r?.role));
  const toRef = (u: any): OperatorRef | null =>
    u && u.status !== "out_of_office" && isOperator(u)
      ? { id: u.id, name: u.display_name ?? u.email ?? "—", email: u.email ?? null }
      : null;

  // user_org_assignments has two FKs to users (user_id + assigned_by), so the
  // embed must name the relationship explicitly or PostgREST errors out.
  const { data: assigns } = await admin
    .from("user_org_assignments")
    .select("users:users!user_org_assignments_user_id_fkey(id, display_name, email, status, user_roles(role))")
    .eq("org_id", orgId);
  const pool = (assigns ?? [])
    .map((a: any) => toRef(a.users))
    .filter((r: OperatorRef | null): r is OperatorRef => !!r);

  const seen = new Set<string>();
  return pool.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).sort((a, b) => a.id.localeCompare(b.id));
}

// Manual supplier→operator assignments for an org (supplier_id → operator_id),
// from the supplier_assignment table. These OVERRIDE the sticky-random default
// when present — an operator explicitly claimed the supplier.
export async function getSupplierAssignments(admin: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  const { data } = await admin
    .from("supplier_assignment")
    .select("supplier_id, operator_id")
    .eq("org_id", orgId);
  const m = new Map<string, string>();
  for (const r of (data ?? []) as { supplier_id: string; operator_id: string }[]) {
    if (r.supplier_id && r.operator_id) m.set(r.supplier_id, r.operator_id);
  }
  return m;
}

// Resolve the operator id for a supplier: a manual assignment wins; otherwise
// fall back to the sticky-random pick over the pool.
export function resolveSupplierOperatorId(
  manual: Map<string, string>,
  pool: OperatorRef[],
  supplierId: string | null | undefined
): string | null {
  if (supplierId && manual.has(supplierId)) return manual.get(supplierId)!;
  return pickSupplierOperator(pool, supplierId)?.id ?? null;
}

// Map every supplier id to its owning operator for an org, using the pool.
export function operatorBySupplier(pool: OperatorRef[], supplierIds: (string | null | undefined)[]): Record<string, OperatorRef> {
  const out: Record<string, OperatorRef> = {};
  for (const sid of supplierIds) {
    if (!sid || out[sid]) continue;
    const op = pickSupplierOperator(pool, sid);
    if (op) out[sid] = op;
  }
  return out;
}
