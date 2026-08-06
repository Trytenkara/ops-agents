import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPaged } from "@/lib/supabase-paging";
import { collectOrgSuppliers } from "@/lib/freeze-assignments";
import { mirrorDraftAssignee } from "@/lib/draft-staging";
import {
  ALL_SUPPLIER_TYPES,
  autoOperator,
  getOrgAssignmentContext,
  leadAutoKey,
  pickSupplierOperator,
  supplierKind,
} from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";

// "Reset assignments for this org": re-run the org's own assignment rules against
// the CURRENT operator pool, so operators added since the last run pick up their
// share instead of inheriting an empty book.
//
// Why a button is needed at all, given owners are derived at read time: the
// derived answer is only consulted where nothing is pinned. Every pin the app
// writes (a manual claim, the freeze that runs when an org goes manual or narrows
// its supplier types, the operator stamped onto a lead or a staged draft at
// creation) outranks or bypasses the spread, and none of them is ever revisited.
// So a new operator joins the pool and the rendezvous hash hands them a slice of
// the derived book while the pinned rows stay exactly where they were.
//
// The reset therefore does two opposite things, deliberately:
//   - Where the rules DO produce an owner (auto mode, supplier in scope), the pin
//     is DELETED so read-time derivation takes over permanently. Idempotent:
//     pressing the button twice changes nothing the second time.
//   - Where the rules produce nobody (manual mode, or a supplier outside
//     assignment_supplier_types), the pin is the only record of ownership, so it
//     is re-pointed across the live pool by the same rendezvous hash rather than
//     dropped. Deleting it would blank the supplier, which is the exact failure
//     b85c90c fixed for scope narrowing.
// Threads follow the supplier: draft_references is re-stamped and the assignee is
// mirrored onto the Tenkara conversation, or Control Room and the email app show
// different owners for the same thread.
//
// Note this DELETES claims rather than leaving them dormant, so an auto_all org
// that resets no longer restores its old claims by switching back to auto_new.
// That is the point of a reset, but it is the one irreversible part.

export interface RebalanceOperatorSplit {
  id: string;
  name: string;
  suppliers: number;
}

export interface RebalanceResult {
  poolSize: number;
  autoPoolSize: number;
  mode: string;
  claimsCleared: number;
  claimsMoved: number;
  leadsCleared: number;
  leadsMoved: number;
  draftsMoved: number;
  // Suppliers per operator once the reset lands, counted over the org's whole
  // book (every active lead plus every claimed supplier), deduped by assignment
  // key so a supplier's material rows count once.
  projected: RebalanceOperatorSplit[];
  unowned: number;
}

interface LeadRow {
  id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  email: string | null;
  assigned_operator_id: string | null;
}

interface DraftRow {
  id: string;
  supplier_id: string | null;
  thread_id: string | null;
  assigned_operator: string | null;
  metadata: any;
}

// Tenkara assignee mirroring is one HTTP round trip per thread, and a reset on a
// large client moves hundreds of them. Sequential mirroring would run past the
// route's maxDuration; unbounded parallelism would hammer the email app.
const MIRROR_CONCURRENCY = 6;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function rebalanceOrgAssignments(
  admin: SupabaseClient,
  orgId: string,
  actorUserId: string,
  opts: { dryRun?: boolean } = {}
): Promise<RebalanceResult> {
  const dryRun = opts.dryRun === true;
  const ctx = await getOrgAssignmentContext(admin, orgId);
  // Refuse rather than blank the org's book: with nobody to hand suppliers to,
  // clearing pins would leave every row "Unassigned".
  if (ctx.pool.length === 0) throw new Error("no eligible operators are assigned to this org");

  // Prefer the auto pool so a re-pointed pin lands on whoever the spread would
  // pick next; fall back to the full pool only when everyone opted out of auto,
  // so a manual org still spreads across its members.
  const pickPool = ctx.autoPool.length > 0 ? ctx.autoPool : ctx.pool;

  // Classification is only consulted when the org narrowed its scope; every
  // supplier is in scope otherwise and the index would go unused.
  const narrowed = ctx.config.supplierTypes.length < ALL_SUPPLIER_TYPES.length;
  const index = narrowed ? await collectOrgSuppliers(admin, orgId) : null;
  const kindOf = (key: string, name?: string | null): MarketKind | null =>
    index ? supplierKind(ctx.supplierTypes, key, name) ?? (index.tenkaraMarketplace.has(key) ? "marketplace" : null) : null;
  const nameOf = (key: string): string | null => index?.names.get(key) ?? null;

  const ruleOwner = (key: string, name?: string | null): string | null =>
    autoOperator(ctx, key, kindOf(key, name), name)?.id ?? null;
  const spreadOwner = (key: string): string | null => pickSupplierOperator(pickPool, key)?.id ?? null;

  const result: RebalanceResult = {
    poolSize: ctx.pool.length,
    autoPoolSize: ctx.autoPool.length,
    mode: ctx.config.mode,
    claimsCleared: 0,
    claimsMoved: 0,
    leadsCleared: 0,
    leadsMoved: 0,
    draftsMoved: 0,
    projected: [],
    unowned: 0,
  };

  // Owner of each assignment key once the reset lands. Filled by the claim and
  // lead passes so the draft pass agrees with them instead of re-deriving and
  // drifting apart, which is the split reassign-owners.ts documents.
  const decided = new Map<string, string>();
  const ownerAfterReset = (key: string, name?: string | null): string | null =>
    decided.get(key) ?? ruleOwner(key, name) ?? ctx.manual.get(key) ?? null;

  // 1. Manual supplier claims.
  const claimRows = await selectAllPaged<{ supplier_id: string; operator_id: string }>((from, to) =>
    admin
      .from("supplier_assignment")
      .select("supplier_id, operator_id")
      .eq("org_id", orgId)
      .order("supplier_id")
      .range(from, to)
  );
  const clearClaims: string[] = [];
  const moveClaims = new Map<string, string[]>();
  for (const r of claimRows) {
    const name = nameOf(r.supplier_id);
    const derived = ruleOwner(r.supplier_id, name);
    if (derived) {
      decided.set(r.supplier_id, derived);
      clearClaims.push(r.supplier_id);
      continue;
    }
    const next = spreadOwner(r.supplier_id);
    if (!next) continue;
    decided.set(r.supplier_id, next);
    if (next === r.operator_id) continue;
    moveClaims.set(next, [...(moveClaims.get(next) ?? []), r.supplier_id]);
  }
  result.claimsCleared = clearClaims.length;
  result.claimsMoved = [...moveClaims.values()].reduce((n, ids) => n + ids.length, 0);

  // 2. Leads. One scan serves both the re-point pass and the projected split, so
  // the preview costs no extra read.
  const leadRows = await selectAllPaged<LeadRow>((from, to) =>
    admin
      .from("leads_in_flight")
      .select("id, supplier_id, supplier_name, assigned_operator_id, email:payload->>supplier_contact_email")
      .eq("org_id", orgId)
      .eq("status", "active")
      .order("id")
      .range(from, to)
  );
  const clearLeads: string[] = [];
  const moveLeads = new Map<string, string[]>();
  const keyByLead = new Map<string, { key: string; name: string | null }>();
  for (const l of leadRows) {
    const key = leadAutoKey({ supplierId: l.supplier_id, supplierName: l.supplier_name, email: l.email, leadId: l.id });
    keyByLead.set(l.id, { key, name: l.supplier_name });
    if (!l.assigned_operator_id) continue;
    // A supplier-backed lead reads its owner from supplier_assignment, so its own
    // stamp is redundant once the claim pass has decided; clearing it keeps the
    // two from disagreeing.
    const derived = decided.get(key) ?? ruleOwner(key, l.supplier_name);
    if (derived) {
      decided.set(key, derived);
      clearLeads.push(l.id);
      continue;
    }
    const next = spreadOwner(key);
    if (!next) continue;
    decided.set(key, next);
    if (next === l.assigned_operator_id) continue;
    moveLeads.set(next, [...(moveLeads.get(next) ?? []), l.id]);
  }
  result.leadsCleared = clearLeads.length;
  result.leadsMoved = [...moveLeads.values()].reduce((n, ids) => n + ids.length, 0);

  // 3. Threads. Every draft, not just the ones on a moved supplier: a draft
  // stamped before the pool changed can sit on an operator the rules no longer
  // pick, and nothing else revisits it.
  const draftRows = await selectAllPaged<DraftRow>((from, to) =>
    admin
      .from("draft_references")
      .select("id, supplier_id, thread_id, assigned_operator, metadata")
      .eq("org_id", orgId)
      .order("id")
      .range(from, to)
  );
  const draftMoves: { id: string; threadId: string | null; operatorId: string }[] = [];
  // Deduped assignment keys for the projection below, collected as we go.
  const ownerByKey = new Map<string, string | null>();
  const project = (key: string, name?: string | null) => {
    if (!ownerByKey.has(key)) ownerByKey.set(key, ownerAfterReset(key, name));
  };
  for (const d of draftRows) {
    // Scout drafts carry no supplier_id, so key them through the lead they were
    // drafted from, the way outreach keyed them when it stamped the first owner.
    const viaLead = d.supplier_id ? null : keyByLead.get(d.metadata?.lead_id ?? "");
    const key = d.supplier_id ?? viaLead?.key ?? null;
    if (!key) continue;
    const name = d.supplier_id ? nameOf(d.supplier_id) : viaLead?.name;
    // A thread on a supplier whose leads all closed is still a live book entry,
    // so it counts toward the projected split even with no active lead behind it.
    project(key, name);
    const target = ownerAfterReset(key, name);
    if (!target || target === d.assigned_operator) continue;
    draftMoves.push({ id: d.id, threadId: d.thread_id, operatorId: target });
  }
  result.draftsMoved = draftMoves.length;

  // 4. Projected book, over every assignment key in the org (deduped, so a
  // supplier's material rows count once) rather than only the rows that moved.
  for (const l of leadRows) {
    const k = keyByLead.get(l.id)!;
    project(k.key, k.name);
  }
  for (const r of claimRows) project(r.supplier_id, nameOf(r.supplier_id));
  const counts = new Map<string, number>();
  for (const owner of ownerByKey.values()) {
    if (!owner) result.unowned++;
    else counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  result.projected = ctx.pool
    .map((op) => ({ id: op.id, name: op.name, suppliers: counts.get(op.id) ?? 0 }))
    .sort((a, b) => b.suppliers - a.suppliers || a.name.localeCompare(b.name));

  if (dryRun) return result;

  // Writes. Claims first: leads and drafts resolve through them, so a failure
  // part-way leaves the book on the old owner rather than split across two.
  for (let i = 0; i < clearClaims.length; i += 500) {
    const { error } = await admin
      .from("supplier_assignment")
      .delete()
      .eq("org_id", orgId)
      .in("supplier_id", clearClaims.slice(i, i + 500));
    if (error) throw new Error(`clearing claims: ${error.message}`);
  }
  for (const [operatorId, ids] of moveClaims) {
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await admin
        .from("supplier_assignment")
        .update({ operator_id: operatorId, assigned_by: actorUserId, updated_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .in("supplier_id", ids.slice(i, i + 500));
      if (error) throw new Error(`moving claims: ${error.message}`);
    }
  }

  // assigned_operator_at is the claim's timestamp, and under auto_all a stamp
  // newer than assignment_auto_all_at outranks the spread. Clear it with the
  // owner, and leave it untouched on a re-point, or the reset would write itself
  // an override of the very rules it just applied.
  //
  // updated_at is deliberately NOT touched on either path: the enrichment queue
  // orders on it, and a reset moving several thousand leads would reshuffle
  // Agent 06's backlog as a side effect of an assignment change.
  for (let i = 0; i < clearLeads.length; i += 500) {
    const { error } = await admin
      .from("leads_in_flight")
      .update({ assigned_operator_id: null, assigned_operator_at: null })
      .eq("org_id", orgId)
      .in("id", clearLeads.slice(i, i + 500));
    if (error) throw new Error(`clearing lead assignees: ${error.message}`);
  }
  for (const [operatorId, ids] of moveLeads) {
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await admin
        .from("leads_in_flight")
        .update({ assigned_operator_id: operatorId })
        .eq("org_id", orgId)
        .in("id", ids.slice(i, i + 500));
      if (error) throw new Error(`moving lead assignees: ${error.message}`);
    }
  }

  for (let i = 0; i < draftMoves.length; i += 200) {
    const chunk = draftMoves.slice(i, i + 200);
    await Promise.all(
      chunk.map(async (m) => {
        const { error } = await admin
          .from("draft_references")
          .update({ assigned_operator: m.operatorId })
          .eq("org_id", orgId)
          .eq("id", m.id);
        if (error) throw new Error(`moving thread assignees: ${error.message}`);
      })
    );
  }
  // Mirror last and best-effort: mirrorDraftAssignee already swallows its own
  // failures, and a Tenkara outage must not roll back a completed rebalance.
  await mapLimit(draftMoves, MIRROR_CONCURRENCY, async (m) => {
    await mirrorDraftAssignee(admin, m.threadId, m.operatorId).catch(() => undefined);
  });

  await admin.from("audit_log").insert({
    actor_user_id: actorUserId,
    action: "org.assignments_rebalanced",
    target_table: "orgs",
    target_id: orgId,
    diff: {
      mode: result.mode,
      pool: ctx.pool.map((p) => ({ id: p.id, name: p.name, auto: p.autoAssignable })),
      claims_cleared: result.claimsCleared,
      claims_moved: result.claimsMoved,
      leads_cleared: result.leadsCleared,
      leads_moved: result.leadsMoved,
      drafts_moved: result.draftsMoved,
      projected: result.projected,
    },
  });

  return result;
}
