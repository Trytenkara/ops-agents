import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPaged } from "@/lib/supabase-paging";

// PERS-02. A lead may leave the active queue because a person is holding it
// somewhere else — an escalation case. That is legitimate: the work moved
// queues, it did not stop. What is not legitimate is leaving it there once the
// holder is gone. A dismissed or resolved case is the end of that person's
// attention, and the lead behind it then sits `dropped` forever with nothing
// pointing at it and no sweep that can see it.
//
// So a hold is a loan, not a disposal, and this module is the only place that
// writes one. Every hold records the case it is waiting on, and `releaseClosedHolds`
// gives the lead back the moment that case stops being open.
//
// Operator drops are NOT holds. When a person looks at a lead and drops it,
// that is a verdict and it stands.

/** Drop reasons that mean "a person is holding this elsewhere", not "this is over". */
export const HOLD_REASONS = {
  /** A case was opened for this exact lead. */
  escalatedToCase: "escalated_to_case",
  /** A case for this supplier×material was already open, so no second one was opened. */
  duplicateOpenCase: "duplicate_open_case",
} as const;

export type HoldReason = (typeof HOLD_REASONS)[keyof typeof HOLD_REASONS];

export const HOLD_REASON_VALUES: HoldReason[] = Object.values(HOLD_REASONS);

const OPEN_CASE_STATUSES = ["open", "in_progress"];

/**
 * Park a lead against a case. The case id is always stored, including for a
 * duplicate: without it the only way back is guessing at supplier×material,
 * and a lead with no supplier resolved matches nothing.
 */
export async function holdLeadForCase(
  admin: SupabaseClient,
  lead: { id: string; payload: any },
  args: { reason: HoldReason; caseId: string; runId: string | null; staleDays?: number; extra?: Record<string, unknown> }
): Promise<{ error: { message: string } | null }> {
  const { error } = await admin
    .from("leads_in_flight")
    .update({
      status: "dropped",
      drop_reason: args.reason,
      payload: {
        ...(lead.payload ?? {}),
        escalation: {
          ...((lead.payload ?? {}).escalation ?? {}),
          case_id: args.caseId,
          held_by_case: true,
          escalated_at: new Date().toISOString(),
          escalated_by_run_id: args.runId,
          ...(args.staleDays != null ? { stale_days: args.staleDays } : {}),
          ...(args.extra ?? {}),
        },
      },
    })
    .eq("id", lead.id);
  return { error: error ? { message: error.message } : null };
}

/**
 * Give back every lead whose holding case is no longer open. Returns the number
 * revived and the number still waiting, so a run can say both.
 *
 * Leads held before this module existed carry no `case_id`. They are matched on
 * org + supplier + material instead, null-safely, which is the same key the
 * escalation sweep deduped them on.
 */
export async function releaseClosedHolds(
  admin: SupabaseClient,
  orgIds: string[]
): Promise<{ revived: number; stillHeld: number; unmatched: number }> {
  if (orgIds.length === 0) return { revived: 0, stillHeld: 0, unmatched: 0 };

  const held = await selectAllPaged<{
    id: string;
    org_id: string;
    supplier_id: string | null;
    material_id: string | null;
    payload: any;
  }>((from, to) =>
    admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_id, material_id, payload")
      .eq("status", "dropped")
      .in("drop_reason", HOLD_REASON_VALUES)
      .in("org_id", orgIds)
      .order("id")
      .range(from, to)
  ).catch(() => []);
  if (held.length === 0) return { revived: 0, stillHeld: 0, unmatched: 0 };

  const openKeys = new Set<string>();
  const openIds = new Set<string>();
  const cases = await selectAllPaged<{ id: string; org_id: string; supplier_id: string | null; material_id: string | null }>(
    (from, to) =>
      admin
        .from("cases")
        .select("id, org_id, supplier_id, material_id")
        .in("org_id", orgIds)
        .in("status", OPEN_CASE_STATUSES)
        .order("id")
        .range(from, to)
  ).catch(() => []);
  for (const c of cases) {
    openIds.add(c.id);
    openKeys.add(`${c.org_id}|${c.supplier_id ?? ""}|${c.material_id ?? ""}`);
  }

  let revived = 0;
  let stillHeld = 0;
  let unmatched = 0;
  for (const l of held) {
    const caseId = (l.payload?.escalation?.case_id as string | undefined) ?? null;
    const stillOpen = caseId
      ? openIds.has(caseId)
      : openKeys.has(`${l.org_id}|${l.supplier_id ?? ""}|${l.material_id ?? ""}`);
    if (stillOpen) {
      stillHeld++;
      continue;
    }
    if (!caseId) unmatched++;
    const { error } = await admin
      .from("leads_in_flight")
      .update({
        status: "active",
        drop_reason: null,
        updated_at: new Date().toISOString(),
        payload: {
          ...(l.payload ?? {}),
          escalation: {
            ...((l.payload ?? {}).escalation ?? {}),
            held_by_case: false,
            released_at: new Date().toISOString(),
            released_because: caseId ? "holding case closed" : "no open case holds this lead",
          },
        },
      })
      .eq("id", l.id);
    if (!error) revived++;
  }
  return { revived, stillHeld, unmatched };
}
