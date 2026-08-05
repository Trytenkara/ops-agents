import type { SupabaseClient } from "@supabase/supabase-js";
import { leadMarketKind, type MarketKind } from "@/lib/lead-market";
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
  // When auto_all was last chosen. A claim made after it is a deliberate
  // correction of the spread and outranks it; older claims are what auto_all was
  // asked to redo. Null on a pre-0095 org = every claim is older.
  autoAllAt: string | null;
}

export const ALL_SUPPLIER_TYPES: MarketKind[] = ["marketplace", "aggregator", "direct"];

// Used when the org row can't be read: the historical behavior, so a failed read
// degrades to routing-as-before rather than routing nothing.
export const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = {
  mode: "auto_new",
  supplierTypes: ALL_SUPPLIER_TYPES,
  autoAllAt: null,
};

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
    .select("assignment_mode, assignment_supplier_types, assignment_auto_all_at")
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
    autoAllAt: (data as any).assignment_auto_all_at ?? null,
  };
}

// assignment key → market kind for an org. Only needed to apply the supplier-type
// scope: callers that already know a lead's kind should pass it to
// resolveOperatorId instead.
//
// Keyed the same way the auto spread is keyed, so a lookup actually hits: by
// supplier_id when the lead has one, else by the Scout consolidation key
// ("e:<email>", falling back to the lead id). Reading supplier_profiles alone is
// not enough — that table's supplier_id is null for all but a handful of rows
// (11,866 of 11,888 on one org), so a supplier_id-only map came back nearly empty
// and every supplier fell through to the "direct" default. An org that narrowed
// its scope to marketplaces then had NOTHING in scope, and auto assignment
// silently stopped covering anything.
export async function getOrgSupplierTypes(admin: SupabaseClient, orgId: string): Promise<Map<string, MarketKind>> {
  const m = new Map<string, MarketKind>();

  // The scanner's per-lead call, keyed by whatever the spread will be keyed by.
  const leads = await selectAllPaged<{
    id: string;
    supplier_id: string | null;
    supplier_name: string | null;
    site_type: string | null;
    email: string | null;
  }>((from, to) =>
    admin
      .from("leads_in_flight")
      .select("id, supplier_id, supplier_name, site_type:payload->>site_type, email:payload->>supplier_contact_email")
      .eq("org_id", orgId)
      .eq("status", "active")
      .order("id")
      .range(from, to)
  ).catch(() => []);
  for (const l of leads) {
    const kind = leadMarketKind(l.site_type);
    if (!kind) continue;
    const email = String(l.email ?? "").trim().toLowerCase();
    m.set(l.supplier_id ?? (email ? `e:${email}` : l.id), kind);
    if (l.supplier_name) m.set(nameKey(l.supplier_name), kind);
  }

  // Agent 06's validated profiles win where they exist: a human/agent confirmed
  // the kind there, whereas site_type is the scanner's first guess.
  const profiles = await selectAllPaged<{ supplier_id: string | null; supplier_name: string | null; supplier_type: string | null }>((from, to) =>
    admin
      .from("supplier_profiles")
      .select("supplier_id, supplier_name, supplier_type")
      .eq("org_id", orgId)
      .order("id")
      .range(from, to)
  ).catch(() => []);
  for (const r of profiles) {
    if (!r.supplier_type || !(ALL_SUPPLIER_TYPES as string[]).includes(r.supplier_type)) continue;
    const kind = r.supplier_type as MarketKind;
    if (r.supplier_id) m.set(r.supplier_id, kind);
    if (r.supplier_name) m.set(nameKey(r.supplier_name), kind);
  }

  return m;
}

// Suppliers reach us from Tenkara with an id that never appears on a lead (Sierra
// has 15k active leads and not one supplier_id), so an id-only lookup classifies
// the whole book as "direct". Name is the only join key those rows share.
export function nameKey(supplierName: string): string {
  return `name:${supplierName.trim().toLowerCase()}`;
}

export function supplierKind(
  types: Map<string, MarketKind>,
  supplierId: string | null | undefined,
  supplierName?: string | null
): MarketKind | null {
  return (
    (supplierId ? types.get(supplierId) ?? null : null) ??
    (supplierName ? types.get(nameKey(supplierName)) ?? null : null)
  );
}

// Manual supplier→operator assignments for an org (supplier_id → operator_id),
// from the supplier_assignment table. These OVERRIDE the sticky-random default
// when present — an operator explicitly claimed the supplier.
export async function getSupplierAssignments(
  admin: SupabaseClient,
  orgId: string
): Promise<{ claims: Map<string, string>; claimedAt: Map<string, string> }> {
  // Paged: switching an org to manual mode writes a claim per supplier, so a
  // large client can hold more than PostgREST's 1000-row cap. A truncated read
  // here would silently hand those suppliers back to the auto spread.
  const rows = await selectAllPaged<{ supplier_id: string; operator_id: string; updated_at: string | null }>((from, to) =>
    admin
      .from("supplier_assignment")
      .select("supplier_id, operator_id, updated_at")
      .eq("org_id", orgId)
      .order("supplier_id")
      .range(from, to)
  );
  const claims = new Map<string, string>();
  const claimedAt = new Map<string, string>();
  for (const r of rows) {
    if (!r.supplier_id || !r.operator_id) continue;
    claims.set(r.supplier_id, r.operator_id);
    if (r.updated_at) claimedAt.set(r.supplier_id, r.updated_at);
  }
  return { claims, claimedAt };
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
  // When each claim was made, so auto_all can tell an override of its spread from
  // the claims it was asked to redo.
  manualAt: Map<string, string>;
  supplierTypes: Map<string, MarketKind>;
}

export async function getOrgAssignmentContext(admin: SupabaseClient, orgId: string): Promise<AssignmentContext> {
  const config = await getOrgAssignmentConfig(admin, orgId).catch(() => DEFAULT_ASSIGNMENT_CONFIG);
  const [pool, manual, supplierTypes] = await Promise.all([
    getOrgOperatorPool(admin, orgId).catch(() => [] as OperatorRef[]),
    getSupplierAssignments(admin, orgId).catch(() => ({
      claims: new Map<string, string>(),
      claimedAt: new Map<string, string>(),
    })),
    // Only read when the org narrowed the scope; every supplier is in scope
    // otherwise and the map would go unused.
    config.supplierTypes.length < ALL_SUPPLIER_TYPES.length
      ? getOrgSupplierTypes(admin, orgId)
      : Promise.resolve(new Map<string, MarketKind>()),
  ]);
  return {
    config,
    pool,
    autoPool: pool.filter((p) => p.autoAssignable),
    manual: manual.claims,
    manualAt: manual.claimedAt,
    supplierTypes,
  };
}

// Is this supplier inside the org's auto-assignment scope? An unknown kind counts
// as "direct", matching how supplier_profiles seeds supplier_type.
function inAutoScope(
  ctx: AssignmentContext,
  supplierId: string | null | undefined,
  kindHint?: MarketKind | null,
  nameHint?: string | null
): boolean {
  const kind = kindHint ?? supplierKind(ctx.supplierTypes, supplierId, nameHint) ?? "direct";
  return ctx.config.supplierTypes.includes(kind);
}

// The sticky-random owner, or null when the org's mode or supplier-type scope
// says this supplier is not the auto loop's business. Pass the supplier name
// wherever it's on hand: an org whose suppliers carry no supplier_id on any lead
// can only be classified by name, and misclassifying one as "direct" drops it out
// of a marketplace-only scope.
export function autoOperator(
  ctx: AssignmentContext,
  supplierId: string | null | undefined,
  kindHint?: MarketKind | null,
  nameHint?: string | null
): OperatorRef | null {
  if (ctx.config.mode === "manual") return null;
  if (!inAutoScope(ctx, supplierId, kindHint, nameHint)) return null;
  return pickSupplierOperator(ctx.autoPool, supplierId);
}

// Does a claim made at `at` beat the auto spread? Everywhere but auto_all a claim
// always wins. Under auto_all only a claim made SINCE the org chose auto_all
// counts: that is an ops lead correcting one supplier after the spread ran, which
// must stick. Older claims are exactly what "reassign all" was asked to redo, and
// they stay in the table, so switching back to auto_new restores them.
export function overridesAuto(ctx: AssignmentContext, at: string | null | undefined): boolean {
  if (ctx.config.mode !== "auto_all") return true;
  const stamp = ctx.config.autoAllAt;
  return !!at && (!stamp || at > stamp);
}

// The effective owner of a supplier for this client. In auto_all the derived
// owner wins over a pre-existing claim, but a claim still stands where auto
// declines to pick (out of scope, empty pool) or where it was made after the
// spread, so nothing loses its operator on a mode change and edits hold.
export function resolveOperatorId(
  ctx: AssignmentContext,
  supplierId: string | null | undefined,
  kindHint?: MarketKind | null,
  nameHint?: string | null
): string | null {
  const claim = supplierId ? ctx.manual.get(supplierId) ?? null : null;
  const auto = autoOperator(ctx, supplierId, kindHint, nameHint)?.id ?? null;
  const claimWins = claim ? overridesAuto(ctx, supplierId ? ctx.manualAt.get(supplierId) : null) : false;
  return claimWins ? claim : auto ?? claim;
}

// Sticky-random owner per supplier id, for tables that show the auto default
// alongside a claim. Names are optional but keep scoped orgs accurate.
export function autoOperatorBySupplier(
  ctx: AssignmentContext,
  suppliers: (string | null | undefined)[] | { id: string | null | undefined; name?: string | null }[]
): Record<string, OperatorRef> {
  const out: Record<string, OperatorRef> = {};
  for (const s of suppliers) {
    const sid = typeof s === "string" || s == null ? s : s.id;
    const name = typeof s === "string" || s == null ? null : s.name ?? null;
    if (!sid || out[sid]) continue;
    const op = autoOperator(ctx, sid, null, name);
    if (op) out[sid] = op;
  }
  return out;
}
