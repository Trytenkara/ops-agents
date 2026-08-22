import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPaged } from "@/lib/supabase-paging";

// OUT-10. A supplier's remaining materials are held (`payload.phased_hold`)
// once a first email goes out, so the reply loop can introduce them after the
// supplier engages. The hold is only ever released by that engagement, and the
// held leads are excluded from the outreach fetch window, so a hold waiting on
// an email that no longer exists is permanent and invisible.
//
// That is what a bulk cancel produces. 2026-08-03: the contact guard blocked
// 128 drafts and left 219 ghost alias rows; Agent 04 was taught to ignore an
// alias whose draft is dead (b3c49ea), but nothing was taught to release the
// leads. On 2026-08-22 that was 24 leads held on a discarded draft, 11 on a
// superseded one, 23 pointing at a draft row that no longer exists and 101
// recording no draft at all.
//
// Releasing is safe: the alias table still stops a second cold email to a
// supplier we really did write to.

/** A draft that still exists as far as outreach is concerned. */
export const LIVE_DRAFT_STATUSES = ["staged", "reviewed", "sent", "linked"];

export async function releaseDeadPhasedHolds(
  admin: SupabaseClient,
  orgIds: string[]
): Promise<{ released: number; stillHeld: number; unidentified: number }> {
  if (orgIds.length === 0) return { released: 0, stillHeld: 0, unidentified: 0 };

  const held = await selectAllPaged<{ id: string; payload: any }>((from, to) =>
    admin
      .from("leads_in_flight")
      .select("id, payload")
      .not("payload->phased_hold", "is", null)
      .in("org_id", orgIds)
      .order("id")
      .range(from, to)
  ).catch(() => []);
  if (held.length === 0) return { released: 0, stillHeld: 0, unidentified: 0 };

  const refIds = [
    ...new Set(
      held
        .map((l) => (l.payload?.phased_hold?.first_pool_draft_ref_id as string | null | undefined) ?? null)
        .filter((x): x is string => !!x)
    ),
  ];
  const live = new Set<string>();
  for (let i = 0; i < refIds.length; i += 500) {
    const { data } = await admin
      .from("draft_references")
      .select("id")
      .in("id", refIds.slice(i, i + 500))
      .in("status", LIVE_DRAFT_STATUSES);
    for (const d of data ?? []) live.add(d.id);
  }

  let released = 0;
  let stillHeld = 0;
  let unidentified = 0;
  for (const lead of held) {
    const hold = lead.payload?.phased_hold ?? {};
    const refId = (hold.first_pool_draft_ref_id as string | null) ?? null;
    const threadId = (hold.first_pool_thread_id as string | null) ?? null;
    if (refId) {
      if (live.has(refId)) {
        stillHeld++;
        continue;
      }
    } else if (threadId) {
      // No draft recorded but a real thread exists, so the email did go out.
      stillHeld++;
      continue;
    } else {
      unidentified++;
    }
    const { phased_hold, ...rest } = lead.payload ?? {};
    const { error } = await admin
      .from("leads_in_flight")
      .update({
        payload: {
          ...rest,
          phased_hold_released: {
            ...phased_hold,
            released_at: new Date().toISOString(),
            released_because: refId ? "the draft holding it is no longer live" : "nothing identified what it was waiting on",
          },
        },
      })
      .eq("id", lead.id);
    if (!error) released++;
  }
  return { released, stillHeld, unidentified };
}
