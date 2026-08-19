import type { SupabaseClient } from "@supabase/supabase-js";
import { leadMarketKind, type MarketKind } from "@/lib/lead-market";
import { selectAllPaged } from "@/lib/supabase-paging";
import { isSameCompanyName } from "@/lib/fuzzy";

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

// Phone work or email work. Held per (user, org), so someone can be a call
// operator for one client and an email operator for another but never both on
// the same one.
export type OperatorType = "call" | "email";

export interface OperatorRef {
  id: string;
  name: string;
  email: string | null;
  // Carried so a surface that resolves an owner can render the same
  // "<name> · <role>" chip as one that read the operator off a join.
  roles: string[];
  // In this org's AUTO loop. False = still a member and still manually
  // assignable, just skipped by the sticky-random spread.
  autoAssignable: boolean;
  operatorType: OperatorType;
  // Market lanes this operator takes for this org. Defaults to all three, so an
  // org that hasn't split its team behaves exactly as it did before lanes.
  lanes: MarketKind[];
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

// Roles that can own a supplier/lead/thread. Shared with the operators actions
// so a role change out of this set and a pool read agree on who counts as removed.
export const ASSIGNABLE_OPERATOR_ROLES = ["ops_operator", "ops_lead"] as const;

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
  const ASSIGNABLE = new Set<string>(ASSIGNABLE_OPERATOR_ROLES);
  const isOperator = (u: any): boolean =>
    Array.isArray(u?.user_roles) && u.user_roles.some((r: any) => ASSIGNABLE.has(r?.role));
  const toRef = (u: any, a: any): OperatorRef | null =>
    u && u.status !== "out_of_office" && !u.deactivated_at && isOperator(u)
      ? {
          id: u.id,
          name: u.display_name ?? u.email ?? "-",
          email: u.email ?? null,
          roles: (u.user_roles ?? []).map((r: any) => r?.role).filter(Boolean),
          autoAssignable: a.auto_assignable !== false,
          operatorType: a.operator_type === "call" ? "call" : "email",
          lanes: Array.isArray(a.lanes)
            ? (a.lanes.filter((l: string) => (ALL_SUPPLIER_TYPES as string[]).includes(l)) as MarketKind[])
            : ALL_SUPPLIER_TYPES,
        }
      : null;

  // user_org_assignments has two FKs to users (user_id + assigned_by), so the
  // embed must name the relationship explicitly or PostgREST errors out.
  const { data: assigns } = await admin
    .from("user_org_assignments")
    .select(
      "auto_assignable, operator_type, lanes, users:users!user_org_assignments_user_id_fkey(id, display_name, email, status, deactivated_at, user_roles(role))"
    )
    .eq("org_id", orgId);
  const pool = (assigns ?? [])
    .map((a: any) => toRef(a.users, a))
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
export interface OrgLeadIndex {
  types: Map<string, MarketKind>;
  // Supplier name key → the ONE key every row of that supplier hashes on. See
  // orgAutoKey.
  keys: Map<string, string>;
}

// A supplier reaches us through rows that don't agree on what identifies it: one
// material row carries a supplier_id, its siblings carry only a contact email,
// and a quote carries neither. Each of those produces a different leadAutoKey, so
// ONE supplier got several keys, the spread treated each as its own supplier, and
// the same supplier's rows rendered under different operators (Lab Alley: 5 rows
// on the email key, 1 on the supplier id, and the operator column disagreed).
// Rank the candidates a name is seen with and keep the strongest, so distribution
// is per supplier rather than per row: supplier id (also what claims key on),
// else the contact email, else the name itself. Ties resolve lexicographically so
// the answer doesn't depend on row order.
function keyRank(key: string): number {
  return key.startsWith("name:") ? 2 : key.startsWith("e:") ? 1 : 0;
}

function strongerKey(current: string | undefined, candidate: string): string {
  if (!current) return candidate;
  const rc = keyRank(current);
  const rn = keyRank(candidate);
  if (rn !== rc) return rn < rc ? candidate : current;
  return candidate < current ? candidate : current;
}

// A supplier whose name is a near-miss of one we already source ("Manoj Plastic"
// and "Manoj Plastics", "Elm Kimya A.S." and "Elm Kimya A.Ş.") is one company as
// far as the supplier is concerned, so it must reach one operator. Exact name
// matches already collapse through nameKey; these do not, and eight of them were
// split across two operators for one client alone.
//
// Only a name key whose rows are ALL newer than this date is merged onto an
// established sibling. Merging retrospectively would move suppliers a client's
// operators are already working, which ops asked us not to do: this applies from
// the next sourcing exercise onward.
const SIMILAR_NAME_GROUPING_FROM = "2026-08-19T00:00:00.000Z";

export function mergeSimilarNameKeys(keys: Map<string, string>, firstSeen: Map<string, string>): void {
  const established: string[] = [];
  const fresh: string[] = [];
  for (const nk of keys.keys()) {
    const seen = firstSeen.get(nk);
    if (seen && seen >= SIMILAR_NAME_GROUPING_FROM) fresh.push(nk);
    else established.push(nk);
  }
  if (!fresh.length || !established.length) return;
  const display = (nk: string) => nk.slice("name:".length);
  for (const nk of fresh) {
    // Oldest established sibling wins, so two new variants of the same existing
    // supplier land on the same operator rather than on each other.
    let best: string | null = null;
    let bestSeen: string | null = null;
    for (const other of established) {
      if (!isSameCompanyName(display(nk), display(other))) continue;
      const seen = firstSeen.get(other) ?? "";
      if (best === null || seen < (bestSeen ?? "")) { best = other; bestSeen = seen; }
    }
    const target = best ? keys.get(best) : undefined;
    if (target) keys.set(nk, target);
  }
}

export async function getOrgLeadIndex(admin: SupabaseClient, orgId: string): Promise<OrgLeadIndex> {
  const types = new Map<string, MarketKind>();
  const keys = new Map<string, string>();
  // Earliest row we have for each supplier name, so the similar-name merge can
  // tell a supplier we have been working from one that just arrived.
  const firstSeen = new Map<string, string>();

  // The scanner's per-lead call, keyed by whatever the spread will be keyed by.
  const leads = await selectAllPaged<{
    id: string;
    supplier_id: string | null;
    supplier_name: string | null;
    site_type: string | null;
    email: string | null;
    created_at: string | null;
  }>((from, to) =>
    admin
      .from("leads_in_flight")
      .select("id, supplier_id, supplier_name, created_at, site_type:payload->>site_type, email:payload->>supplier_contact_email")
      .eq("org_id", orgId)
      .eq("status", "active")
      .order("id")
      .range(from, to)
  ).catch(() => []);
  for (const l of leads) {
    if (l.supplier_name) {
      const nk = nameKey(l.supplier_name);
      const seen = l.created_at ?? "";
      if (seen && (!firstSeen.has(nk) || seen < firstSeen.get(nk)!)) firstSeen.set(nk, seen);
      keys.set(
        nk,
        strongerKey(
          keys.get(nk),
          leadAutoKey({ supplierId: l.supplier_id, supplierName: l.supplier_name, email: l.email, leadId: l.id })
        )
      );
    }
    const kind = leadMarketKind(l.site_type);
    if (!kind) continue;
    types.set(leadAutoKey({ supplierId: l.supplier_id, supplierName: l.supplier_name, email: l.email, leadId: l.id }), kind);
    if (l.supplier_name) types.set(nameKey(l.supplier_name), kind);
  }

  // Agent 06's validated profiles win where they exist: a human/agent confirmed
  // the kind there, whereas site_type is the scanner's first guess.
  const profiles = await selectAllPaged<{
    supplier_id: string | null;
    supplier_name: string | null;
    supplier_type: string | null;
    poc_email: string | null;
    created_at: string | null;
  }>((from, to) =>
    admin
      .from("supplier_profiles")
      .select("supplier_id, supplier_name, supplier_type, poc_email, created_at")
      .eq("org_id", orgId)
      .order("id")
      .range(from, to)
  ).catch(() => []);
  for (const r of profiles) {
    if (r.supplier_name) {
      const nk = nameKey(r.supplier_name);
      const seen = r.created_at ?? "";
      if (seen && (!firstSeen.has(nk) || seen < firstSeen.get(nk)!)) firstSeen.set(nk, seen);
      keys.set(
        nk,
        strongerKey(
          keys.get(nk),
          leadAutoKey({ supplierId: r.supplier_id, supplierName: r.supplier_name, email: r.poc_email, leadId: nk })
        )
      );
    }
    if (!r.supplier_type || !(ALL_SUPPLIER_TYPES as string[]).includes(r.supplier_type)) continue;
    const kind = r.supplier_type as MarketKind;
    if (r.supplier_id) types.set(r.supplier_id, kind);
    if (r.supplier_name) types.set(nameKey(r.supplier_name), kind);
  }

  mergeSimilarNameKeys(keys, firstSeen);

  return { types, keys };
}

export async function getOrgSupplierTypes(admin: SupabaseClient, orgId: string): Promise<Map<string, MarketKind>> {
  return (await getOrgLeadIndex(admin, orgId)).types;
}

// Suppliers reach us from Tenkara with an id that never appears on a lead (Sierra
// has 15k active leads and not one supplier_id), so an id-only lookup classifies
// the whole book as "direct". Name is the only join key those rows share.
export function nameKey(supplierName: string): string {
  return `name:${supplierName.trim().toLowerCase()}`;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The sticky key for a lead the auto spread hashes on. supplier_id when we have
// one, else the supplier's EMAIL so every material row of one supplier collapses
// to the operator who owns its single consolidated outreach thread.
//
// supplier_contact_email is NOT always an address: marketplace leads park a prose
// channel note there ("via IndiaMART inquiry", "via website"). Hashing those
// collapsed 62 unrelated IndiaMART suppliers onto one key and so onto one
// operator, which skewed Sierra's marketplace book 265/246/155/131/130 across a
// 5-person pool that should have been ~185 each. Fall back to the supplier NAME,
// not the lead id: the name is stable across a supplier's material rows, so
// consolidation survives while unrelated suppliers separate.
export function leadAutoKey(input: {
  supplierId?: string | null;
  supplierName?: string | null;
  email?: string | null;
  leadId: string;
}): string {
  if (input.supplierId) return input.supplierId;
  const email = String(input.email ?? "").trim().toLowerCase();
  if (EMAIL_SHAPE.test(email)) return `e:${email}`;
  const name = String(input.supplierName ?? "").trim();
  return name ? nameKey(name) : input.leadId;
}

// The key a row hashes on, once the org's other rows have had their say. A row
// carrying a supplier_id keeps it: it is already supplier-scoped, and it is what
// supplier_assignment claims key on. Everything else adopts its supplier's key,
// so a quote with only a name, a Scout lead with only an email, and a lead
// carrying the supplier id all resolve to ONE operator instead of three.
export function orgAutoKey(
  ctx: AssignmentContext,
  input: { supplierId?: string | null; supplierName?: string | null; email?: string | null; leadId: string }
): string {
  if (input.supplierId) return input.supplierId;
  const name = String(input.supplierName ?? "").trim();
  if (name) return ctx.supplierKeys.get(nameKey(name)) ?? leadAutoKey(input);
  return leadAutoKey(input);
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
  // Supplier name key → the key that supplier's rows hash on. See orgAutoKey.
  supplierKeys: Map<string, string>;
}

export async function getOrgAssignmentContext(admin: SupabaseClient, orgId: string): Promise<AssignmentContext> {
  const config = await getOrgAssignmentConfig(admin, orgId).catch(() => DEFAULT_ASSIGNMENT_CONFIG);
  const [pool, manual, index] = await Promise.all([
    getOrgOperatorPool(admin, orgId).catch(() => [] as OperatorRef[]),
    getSupplierAssignments(admin, orgId).catch(() => ({
      claims: new Map<string, string>(),
      claimedAt: new Map<string, string>(),
    })),
    // Read unconditionally: the scope map is only needed by a narrowed org, but
    // the key map decides which key a supplier's rows share, and every org needs
    // that or its own rows disagree about who owns the supplier.
    getOrgLeadIndex(admin, orgId).catch(() => ({
      types: new Map<string, MarketKind>(),
      keys: new Map<string, string>(),
    })),
  ]);
  return {
    config,
    pool,
    autoPool: pool.filter((p) => p.autoAssignable),
    manual: manual.claims,
    manualAt: manual.claimedAt,
    supplierTypes: index.types,
    supplierKeys: index.keys,
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

// Narrow a pool to the people who actually do this work: the right type (phone
// vs email) and the right market lane.
//
// The lane filter falls back to the unnarrowed pool rather than returning nobody:
// a client with no one covering aggregators must still have that work land on a
// person, and a call operator who covers only marketplace is still the person who
// makes this client's calls.
//
// The type filter falls back for email work (desk work is what an operator does
// unless told otherwise) but NOT for phone work. Handing a call to the email team
// tags someone who doesn't make calls, which reads as a ping to ignore and hides
// the real problem: the client has no caller named. A client with no call operator
// gets an unowned call task that says so.
export function poolForWork(
  pool: OperatorRef[],
  opts: { type?: OperatorType | null; lane?: MarketKind | null }
): OperatorRef[] {
  let out = pool;
  if (opts.type) {
    const byType = out.filter((o) => o.operatorType === opts.type);
    if (byType.length || opts.type === "call") out = byType;
  }
  if (opts.lane) {
    const lane = opts.lane;
    const byLane = out.filter((o) => o.lanes.includes(lane));
    if (byLane.length) out = byLane;
  }
  return out;
}

// The sticky-random owner, or null when the org's mode or supplier-type scope
// says this supplier is not the auto loop's business. Pass the supplier name
// wherever it's on hand: an org whose suppliers carry no supplier_id on any lead
// can only be classified by name, and misclassifying one as "direct" drops it out
// of a marketplace-only scope.
//
// `workType` defaults to email: everything routed through here (outreach drafts,
// leads, quotes) is desk work. Phone work resolves through CallOperatorResolver,
// which asks for the call pool instead.
export function autoOperator(
  ctx: AssignmentContext,
  supplierId: string | null | undefined,
  kindHint?: MarketKind | null,
  nameHint?: string | null,
  workType: OperatorType = "email"
): OperatorRef | null {
  if (ctx.config.mode === "manual") return null;
  if (!inAutoScope(ctx, supplierId, kindHint, nameHint)) return null;
  const lane = kindHint ?? supplierKind(ctx.supplierTypes, supplierId, nameHint) ?? "direct";
  return pickSupplierOperator(poolForWork(ctx.autoPool, { type: workType, lane }), supplierId);
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
  nameHint?: string | null,
  workType: OperatorType = "email"
): string | null {
  const claim = supplierId ? ctx.manual.get(supplierId) ?? null : null;
  const auto = autoOperator(ctx, supplierId, kindHint, nameHint, workType)?.id ?? null;
  // A claim says who owns the supplier, which historically meant its email. It
  // must not drag phone work onto someone who doesn't do phone work: only a claim
  // held by one of the client's call operators counts for a call, and a client
  // with none has no claim that counts.
  const claimDoesThisWork = claim ? poolForWork(ctx.pool, { type: workType }).some((o) => o.id === claim) : false;
  const claimWins =
    claim && claimDoesThisWork ? overridesAuto(ctx, supplierId ? ctx.manualAt.get(supplierId) : null) : false;
  return claimWins ? claim : auto ?? (claimDoesThisWork ? claim : null);
}

// The owner of one piece of work, which lands on a person whenever the client
// has any operators at all.
//
// resolveOperatorId is allowed to decline: the org runs manual assignment, the
// supplier's kind is outside the auto scope, or there is simply no claim. What
// used to catch those was the org's Primary operator, which meant every unrouted
// item in the client piled onto one desk (and onto the Backup whenever that
// person was out). This spreads them over the people who do this kind of work
// instead, keyed on the supplier so the same supplier keeps reaching the same
// operator.
//
// The fallback covers ONE case: a supplier outside the org's auto scope, where
// the work still has to reach a person. It must not be a way around the two
// switches that say who may be handed work. It used to spread over ctx.pool in
// every mode, which meant a manual client and an operator explicitly pulled out
// of the auto loop were both quietly overruled: SaponIQ ran manual with all ten
// operators auto_assignable=false, and still had 270 of 274 drafts stamped with
// an owner, while the Leads tab correctly showed them unassigned.
export function spreadOwnerId(
  ctx: AssignmentContext,
  key: string | null | undefined,
  opts: { lane?: MarketKind | null; nameHint?: string | null; workType?: OperatorType } = {}
): string | null {
  const workType = opts.workType ?? "email";
  const resolved = resolveOperatorId(ctx, key, opts.lane ?? null, opts.nameHint ?? null, workType);
  if (resolved) return resolved;
  // Manual means this client's operators claim their own work. Nothing is handed
  // out, and unowned is the correct answer rather than a gap to paper over.
  if (ctx.config.mode === "manual") return null;
  const lane = opts.lane ?? supplierKind(ctx.supplierTypes, key, opts.nameHint) ?? null;
  // autoPool, not pool: someone excluded from the auto loop is still manually
  // assignable, but must never be handed work by the spread.
  return (
    pickSupplierOperator(poolForWork(ctx.autoPool, { type: workType, lane }), key ?? opts.nameHint ?? null)?.id ?? null
  );
}

// The owner of one open record (a draft, a case) as every read surface must show
// it. This existed as three hand-copied blocks — the Thread Tracker, the case
// list, and the Tenkara inbox sync — each rebuilding the same key from the same
// metadata fields. They agreed only by inspection, and the whole reason the sync
// exists is that Control Room and the email app once named different people.
// Two copies of the rule is how that comes back, so there is one.
export function recordOwnerId(
  ctx: AssignmentContext,
  row: { id: string; supplier_id?: string | null; metadata?: any },
  workType: OperatorType = "email"
): string | null {
  const supplierName = (row.metadata?.supplier_name as string | undefined) ?? null;
  return spreadOwnerId(
    ctx,
    orgAutoKey(ctx, {
      supplierId: row.supplier_id ?? null,
      supplierName,
      email: (row.metadata?.supplier_contact_email as string | undefined) ?? null,
      // A supplier reached through one lead keeps one owner, so the lead is the
      // key when there is no supplier row yet; the draft's own id only as a last
      // resort, which is per-draft and therefore not sticky.
      leadId: (row.metadata?.lead_id as string | undefined) ?? row.id,
    }),
    { nameHint: supplierName, workType }
  );
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
    // Route through orgAutoKey so the Suppliers tab hashes on the same
    // canonical key as the Leads and Quote Validation tabs. Without this,
    // the Suppliers tab hashes on the raw Tenkara supplier_id while the
    // other tabs resolve to an email or name key, and the same supplier
    // can show different operators on different pages.
    const key = orgAutoKey(ctx, { supplierId: sid, supplierName: name, leadId: sid });
    const op = autoOperator(ctx, key, null, name);
    if (op) out[sid] = op;
  }
  return out;
}
