import type { SupabaseClient } from "@supabase/supabase-js";
import { pairKey } from "./supplier-dupes";

// Loads the operator decisions for one org and reassembles them into the shapes
// the Suppliers page renders: a set of rejected pairs to suppress, and the
// confirmed groups waiting to be merged in Tenkara.

export interface DecisionRow {
  supplier_id_lo: string;
  supplier_id_hi: string;
  supplier_name_lo: string | null;
  supplier_name_hi: string | null;
  decision: "not_duplicate" | "same_company";
  survivor_supplier_id: string | null;
  resolved_at: string | null;
}

export interface ConfirmedGroup {
  supplierIds: string[];
  names: Record<string, string>;
  survivorId: string | null;
  resolvedAt: string | null;
}

export interface OrgDupeDecisions {
  /** "<lo>:<hi>" keys the operator said are different companies. */
  dismissedPairs: Set<string>;
  /** Confirmed, not yet merged in Tenkara. */
  toMerge: ConfirmedGroup[];
  /** Confirmed and reported done. */
  merged: ConfirmedGroup[];
  /** Every supplier id under a confirmed decision, so it is not re-suggested. */
  confirmedIds: Set<string>;
}

const EMPTY: OrgDupeDecisions = {
  dismissedPairs: new Set(),
  toMerge: [],
  merged: [],
  confirmedIds: new Set(),
};

/**
 * Rebuilds groups from stored pairs by union-find: any two suppliers joined by a
 * same_company pair belong to the same group, however the operator got there
 * (confirming A+B and later B+C means A, B and C are one company).
 */
function rebuildGroups(rows: DecisionRow[]): ConfirmedGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x);
    if (p === undefined || p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  const names: Record<string, string> = {};
  const survivorVotes = new Map<string, string>();
  const resolvedAt = new Map<string, string | null>();

  for (const r of rows) {
    if (!parent.has(r.supplier_id_lo)) parent.set(r.supplier_id_lo, r.supplier_id_lo);
    if (!parent.has(r.supplier_id_hi)) parent.set(r.supplier_id_hi, r.supplier_id_hi);
    union(r.supplier_id_lo, r.supplier_id_hi);
    if (r.supplier_name_lo) names[r.supplier_id_lo] = r.supplier_name_lo;
    if (r.supplier_name_hi) names[r.supplier_id_hi] = r.supplier_name_hi;
  }

  const buckets = new Map<string, Set<string>>();
  for (const r of rows) {
    const root = find(r.supplier_id_lo);
    if (!buckets.has(root)) buckets.set(root, new Set());
    buckets.get(root)!.add(r.supplier_id_lo);
    buckets.get(root)!.add(r.supplier_id_hi);
    if (r.survivor_supplier_id) survivorVotes.set(root, r.survivor_supplier_id);
    // A group counts as merged only once every pair in it is reported done.
    const prev = resolvedAt.get(root);
    resolvedAt.set(root, prev === undefined ? r.resolved_at : prev && r.resolved_at ? prev : null);
  }

  return [...buckets.entries()].map(([root, ids]) => ({
    supplierIds: [...ids].sort(),
    names: Object.fromEntries([...ids].map((id) => [id, names[id] ?? id])),
    survivorId: survivorVotes.get(root) ?? null,
    resolvedAt: resolvedAt.get(root) ?? null,
  }));
}

export async function getOrgDupeDecisions(
  admin: SupabaseClient,
  orgId: string
): Promise<OrgDupeDecisions> {
  const { data, error } = await admin
    .from("supplier_dupe_decisions")
    .select(
      "supplier_id_lo, supplier_id_hi, supplier_name_lo, supplier_name_hi, decision, survivor_supplier_id, resolved_at"
    )
    .eq("org_id", orgId);
  if (error) {
    console.error("[supplier-dupe-decisions] load failed:", error.message);
    return EMPTY;
  }
  const rows = (data ?? []) as DecisionRow[];

  const dismissedPairs = new Set<string>();
  const sameCompany: DecisionRow[] = [];
  for (const r of rows) {
    if (r.decision === "not_duplicate") dismissedPairs.add(pairKey(r.supplier_id_lo, r.supplier_id_hi));
    else sameCompany.push(r);
  }

  const groups = rebuildGroups(sameCompany);
  const confirmedIds = new Set<string>();
  for (const g of groups) for (const id of g.supplierIds) confirmedIds.add(id);

  return {
    dismissedPairs,
    toMerge: groups.filter((g) => !g.resolvedAt),
    merged: groups.filter((g) => !!g.resolvedAt),
    confirmedIds,
  };
}
