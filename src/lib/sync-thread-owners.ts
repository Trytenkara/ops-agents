import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPaged } from "@/lib/supabase-paging";
import { getOrgAssignmentContext, orgAutoKey, spreadOwnerId } from "@/lib/operator-assignment";
import { mirrorDraftAssignee } from "@/lib/draft-staging";

// Re-derive the owner of an org's OPEN threads and push it to the Tenkara inbox.
//
// Control Room derives an owner every time a tab renders, but the email app holds
// whatever was last pushed to it, so the two agree only for as long as the inputs
// to the derivation stay still. Change a lane, flip someone's desk from email to
// phone, or take someone out of the auto loop, and Control Room moves 100+ threads
// on the next page load while the inbox keeps showing the previous owner. That is
// exactly what operators report as "the email app and Control Room disagree":
// after Cal Chem's lanes were edited, 125 of 1,103 open threads named a different
// person in each place.
//
// The reset button (rebalanceOrgAssignments) already fixes this, but it also
// DELETES supplier claims, which is irreversible and far more than a lane toggle
// asked for. This is the narrow, non-destructive half: draft stamps and the Tenkara
// mirror only. No claims, no leads.
//
// Only work still in front of an operator is touched. A sent draft keeps its
// stamp: that is who the supplier will reply to.
const OPEN_DRAFT_STATUSES = ["staged", "blocked", "reviewed"];

const MIRROR_CONCURRENCY = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}

export interface ThreadOwnerSyncResult {
  examined: number;
  moved: number;
  // Threads Control Room moved but Tenkara refused. Non-zero means the inbox is
  // still behind and the sync should be run again; it is reported rather than
  // thrown so a Tenkara outage cannot roll back a config change that already saved.
  mirrorsFailed: number;
}

export async function syncOrgThreadOwners(
  admin: SupabaseClient,
  orgId: string
): Promise<ThreadOwnerSyncResult> {
  const result: ThreadOwnerSyncResult = { examined: 0, moved: 0, mirrorsFailed: 0 };
  const ctx = await getOrgAssignmentContext(admin, orgId);

  const drafts = await selectAllPaged<{
    id: string;
    supplier_id: string | null;
    thread_id: string | null;
    assigned_operator: string | null;
    metadata: any;
  }>((from, to) =>
    admin
      .from("draft_references")
      .select("id, supplier_id, thread_id, assigned_operator, metadata")
      .eq("org_id", orgId)
      .in("status", OPEN_DRAFT_STATUSES)
      .order("id")
      .range(from, to)
  ).catch(() => []);
  result.examined = drafts.length;

  const moves: { id: string; threadId: string | null; operatorId: string }[] = [];
  for (const d of drafts) {
    const supplierName = (d.metadata?.supplier_name as string | undefined) ?? null;
    const owner = spreadOwnerId(
      ctx,
      orgAutoKey(ctx, {
        supplierId: d.supplier_id,
        supplierName,
        email: (d.metadata?.supplier_contact_email as string | undefined) ?? null,
        leadId: (d.metadata?.lead_id as string | undefined) ?? d.id,
      }),
      { nameHint: supplierName, workType: "email" }
    );
    // Derivation declining to own the thread leaves the stamp alone. Clearing it
    // would blank the only record of ownership for a client whose pool went empty.
    if (!owner || owner === d.assigned_operator) continue;
    moves.push({ id: d.id, threadId: d.thread_id, operatorId: owner });
  }

  for (const m of moves) {
    const { error } = await admin
      .from("draft_references")
      .update({ assigned_operator: m.operatorId })
      .eq("org_id", orgId)
      .eq("id", m.id);
    if (!error) result.moved++;
  }

  // Mirror after the local writes, so a Tenkara failure leaves Control Room
  // correct and only the inbox behind. 429s back off rather than being dropped:
  // a swallowed mirror is indistinguishable from "this thread was already right".
  await mapLimit(moves, MIRROR_CONCURRENCY, async (m) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ok = await mirrorDraftAssignee(admin, m.threadId, m.operatorId).catch(() => false);
      if (ok) return;
      await sleep(500 * 2 ** attempt);
    }
    result.mirrorsFailed += 1;
  });

  return result;
}
