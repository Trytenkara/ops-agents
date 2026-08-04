import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketKind } from "@/lib/lead-market";
import { selectAllPaged } from "@/lib/supabase-paging";

// Sticky-random operator assignment. A supplier is always owned by the SAME
// operator within an org (so the supplier sees one point of contact), but
// suppliers are spread across the org's operators. We hash the supplier id
// against the org's operator pool. Deterministic (stable per supplier, survives
// re-runs, no storage/races) yet evenly distributed.
//
// How much of that an org gets is its own choice (orgs.assignment_mode, see
// AssignmentConfig). Resolve through getOrgAssignmentContext + resolveOperatorId
// rather than calling pickSupplierOperator directly, or a caller silently
// auto-assigns for an org that asked for manual.

export interface OperatorRef {
  id: string;
  name: string;
  email: string | null;
  // In this org's AUTO loop. False = still a member and still manually
  // assignable, just skipped by the sticky-random spread.
  autoAssignable: boolean;
}

// manual   — only explicit claims own anything; the auto spread is off.
// auto_new — a claim wins, auto fills every unclaimed supplier (long-time default).
// auto_all — auto owns every supplier in scope; claims are ignored while it's set,
//            never deleted, so switching back restores them.
export type AssignmentMode = "manual" | "auto_new" | "auto_all";

export interface AssignmentConfig {
  mode: AssignmentMode;
  // Market kinds the auto loop covers. A supplier of any other kind keeps its
  // claim and gets no derived owner.
  supplierTypes: MarketKind[];
}

export const ALL_SUPPLIER_TYPES: MarketKind[] = ["marketplace", "aggregator", "direct"];

// Used when the org row can't be read: the historical behavior, so a failed read
// degrades to routing-as-before rather than routing nothing.
export const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = { mode: "auto_new", supplierTypes: ALL_SUPPLIER_TYPES };

// FNV-1a plus a murmur3 avalanche finalizer. The finalizer matters: picking the
// max hash across the pool amplifies any weakness in the mix into a permanently
// lucky operator, and raw FNV-1a over near-identical "<supplierId>:<operatorId>"
// strings left one operator ~25% over quota. Mixed, every operator lands within
// ~10% of an even share.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

// Rendezvous ("highest random weight") pick, NOT `hash % pool.length`. Modulo
// depends on the pool SIZE, so adding one operator to an org re-derived the owner
// of nearly every supplier, so the whole team's book of business appeared to churn
// overnight. Rendezvous only moves the suppliers the newcomer outranks, so adding
// or removing an operator moves ~1/N of them and leaves everyone else's alone.
export function pickSupplierOperator<T extends { id: string }>(
  pool: T[],
  supplierId: string | null | undefined
): T | null {
  if (pool.length === 0) return null;
  if (!supplierId) return pool[0];
  let best = pool[0];
  let bestScore = -1;
  for (const op of pool) {
    const score = hashStr(`${supplierId}:${op.id}`);
    // Tie-break on id so a hash collision still resolves the same way every run.
    if (score > bestScore || (score === bestScore && op.id < best.id)) {
      best = op;
      bestScore = score;
    }
  }
  return best;
}

// The operators an org's suppliers can be assigned to: everyone explicitly
// assigned to the org (user_org_assignments), minus anyone out of office.
// Sorted by id so the pool order is stable across runs.
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
  const toRef = (u: any, autoAssignable: boolean): OperatorRef | null =>
    u && u.status !== "out_of_office" && isOperator(u)
      ? { id: u.id, name: u.display_name ?? u.email ?? "-", email: u.email ?? null, autoAssignable }
      : null;

  // user_org_assignments has two FKs to users (user_id + assigned_by), so the
  // embed must name the relationship explicitly or PostgREST errors out.
  const { data: assigns } = await admin
    .from("user_org_assignments")
    .select("auto_assignable, users:users!user_org_assignments_user_id_fkey(id, display_name, email, status, user_roles(role))")
    .eq("org_id", orgId);
  const pool = (assigns ?? [])
    .map((a: any) => toRef(a.users, a.auto_assignable !== false))
    .filter((r: OperatorRef | null): r is OperatorRef => !!r);

  const seen = new Set<string>();
  return pool.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getOrgAssignmentConfig(admin: SupabaseClient, orgId: string): Promise<AssignmentConfig> {
  const { data } = await admin
    .from("orgs")
    .select("assignment_mode, assignment_supplier_types")
    .eq("id", orgId)
    .maybeSingle();
  if (!data) return DEFAULT_ASSIGNMENT_CONFIG;
  const mode = (data as any).assignment_mode;
  const types = (data as any).assignment_supplier_types;
  return {
    mode: mode === "manual" || mode === "auto_new" || mode === "auto_all" ? mode : DEFAULT_ASSIGNMENT_CONFIG.mode,
    supplierTypes: Array.isArray(types)
      ? (types.filter((t: string) => (ALL_SUPPLIER_TYPES as string[]).includes(t)) as MarketKind[])
      : ALL_SUPPLIER_TYPES,
  };
}

// supplier_id → market kind for an org, from the validation profiles Agent 06
// maintains. Only needed to apply the supplier-type scope: callers that already
// know a lead's kind should pass it to resolveOperatorId instead.
export async function getOrgSupplierTypes(admin: SupabaseClient, orgId: string): Promise<Map<string, MarketKind>> {
  const rows = await selectAllPaged<{ supplier_id: string | null; supplier_type: string | null }>((from, to) =>
    admin
      .from("supplier_profiles")
      .select("supplier_id, supplier_type")
      .eq("org_id", orgId)
      .not("supplier_id", "is", null)
      .order("supplier_id")
      .range(from, to)
  ).catch(() => []);
  const m = new Map<string, MarketKind>();
  for (const r of rows) {
    if (r.supplier_id && r.supplier_type && (ALL_SUPPLIER_TYPES as string[]).includes(r.supplier_type)) {
      m.set(r.supplier_id, r.supplier_type as MarketKind);
    }
  }
  return m;
}

// Manual supplier→operator assignments for an org (supplier_id → operator_id),
// from the supplier_assignment table. These OVERRIDE the sticky-random default
// when present — an operator explicitly claimed the supplier.
export async function getSupplierAssignments(admin: SupabaseClient, orgId: string): Promise<Map<string, string>> {
  // Paged: switching an org to manual mode writes a claim per supplier, so a
  // large client can hold more than PostgREST's 1000-row cap. A truncated read
  // here would silently hand those suppliers back to the auto spread.
  const rows = await selectAllPaged<{ supplier_id: string; operator_id: string }>((from, to) =>
    admin.from("supplier_assignment").select("supplier_id, operator_id").eq("org_id", orgId).order("supplier_id").range(from, to)
  );
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.supplier_id && r.operator_id) m.set(r.supplier_id, r.operator_id);
  }
  return m;
}

// Everything needed to answer "who owns this supplier for this client".
export interface AssignmentContext {
  config: AssignmentConfig;
  // Every operator in the org: who a supplier can be MANUALLY assigned to, and
  // the names to render assignments with.
  pool: OperatorRef[];
  // The subset the auto spread draws from.
  autoPool: OperatorRef[];
  manual: Map<string, string>;
  supplierTypes: Map<string, MarketKind>;
}

export async function getOrgAssignmentContext(admin: SupabaseClient, orgId: string): Promise<AssignmentContext> {
  const config = await getOrgAssignmentConfig(admin, orgId).catch(() => DEFAULT_ASSIGNMENT_CONFIG);
  const [pool, manual, supplierTypes] = await Promise.all([
    getOrgOperatorPool(admin, orgId).catch(() => [] as OperatorRef[]),
    getSupplierAssignments(admin, orgId).catch(() => new Map<string, string>()),
    // Only read when the org narrowed the scope; every supplier is in scope
    // otherwise and the map would go unused.
    config.supplierTypes.length < ALL_SUPPLIER_TYPES.length
      ? getOrgSupplierTypes(admin, orgId)
      : Promise.resolve(new Map<string, MarketKind>()),
  ]);
  return { config, pool, autoPool: pool.filter((p) => p.autoAssignable), manual, supplierTypes };
}

// Is this supplier inside the org's auto-assignment scope? An unknown kind counts
// as "direct", matching how supplier_profiles seeds supplier_type.
function inAutoScope(ctx: AssignmentContext, supplierId: string | null | undefined, kindHint?: MarketKind | null): boolean {
  const kind = kindHint ?? (supplierId ? ctx.supplierTypes.get(supplierId) : null) ?? "direct";
  return ctx.config.supplierTypes.includes(kind);
}

// The sticky-random owner, or null when the org's mode or supplier-type scope
// says this supplier is not the auto loop's business.
export function autoOperator(
  ctx: AssignmentContext,
  supplierId: string | null | undefined,
  kindHint?: MarketKind | null
): OperatorRef | null {
  if (ctx.config.mode === "manual") return null;
  if (!inAutoScope(ctx, supplierId, kindHint)) return null;
  return pickSupplierOperator(ctx.autoPool, supplierId);
}

// The effective owner of a supplier for this client. In auto_all the derived
// owner wins, but a claim still stands where auto declines to pick (out of
// scope, empty pool), so nothing loses its operator on a mode change.
export function resolveOperatorId(
  ctx: AssignmentContext,
  supplierId: string | null | undefined,
  kindHint?: MarketKind | null
): string | null {
  const claim = supplierId ? ctx.manual.get(supplierId) ?? null : null;
  const auto = autoOperator(ctx, supplierId, kindHint)?.id ?? null;
  return ctx.config.mode === "auto_all" ? auto ?? claim : claim ?? auto;
}

// Sticky-random owner per supplier id, for tables that show the auto default
// alongside a claim.
export function autoOperatorBySupplier(
  ctx: AssignmentContext,
  supplierIds: (string | null | undefined)[]
): Record<string, OperatorRef> {
  const out: Record<string, OperatorRef> = {};
  for (const sid of supplierIds) {
    if (!sid || out[sid]) continue;
    const op = autoOperator(ctx, sid);
    if (op) out[sid] = op;
  }
  return out;
}
