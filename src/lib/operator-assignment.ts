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
  const toRef = (u: any): OperatorRef | null =>
    u && u.status !== "out_of_office" ? { id: u.id, name: u.display_name ?? u.email ?? "—", email: u.email ?? null } : null;

  const { data: assigns } = await admin
    .from("user_org_assignments")
    .select("users(id, display_name, email, status)")
    .eq("org_id", orgId);
  let pool = (assigns ?? [])
    .map((a: any) => toRef(a.users))
    .filter((r: OperatorRef | null): r is OperatorRef => !!r);

  if (pool.length === 0) {
    const { data: def } = await admin
      .from("org_default_operators")
      .select("primary_user_id, backup_user_id")
      .eq("org_id", orgId)
      .maybeSingle();
    const ids = [def?.primary_user_id, def?.backup_user_id].filter((x): x is string => !!x);
    if (ids.length) {
      const { data: users } = await admin.from("users").select("id, display_name, email, status").in("id", ids);
      pool = (users ?? []).map(toRef).filter((r): r is OperatorRef => !!r);
    }
  }

  const seen = new Set<string>();
  return pool.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).sort((a, b) => a.id.localeCompare(b.id));
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
