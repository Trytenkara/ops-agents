import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncOrgThreadOwners } from "@/lib/sync-thread-owners";

// Agent 21 - Thread Owner Sync.
//
// Keeps the Tenkara inbox showing the same owner Control Room shows.
//
// Control Room DERIVES the owner of a supplier every time a tab renders. The
// email app only knows what was last pushed to it. So the two agree exactly as
// long as the inputs to the derivation stay still, and drift the moment anything
// moves. The config edits are now reconciled where they happen (see
// actions/assignment-settings.ts and actions/operators.ts), but plenty of inputs
// change with no operator action at all:
//
//   - a lead's site_type resolves later, moving the supplier into another lane
//   - a supplier profile lands or changes supplier_type
//   - supplier_id resolves on a lead that had only a name, changing its key
//   - a supplier claim is added or dropped directly
//   - a mirror push failed at the time (Tenkara 429/5xx) and nobody re-ran it
//
// None of those can be hooked, so this is the backstop: re-derive every open
// thread daily and push what moved. Non-destructive by construction (it writes
// the draft stamp and the Tenkara assignee, never claims or leads), and free:
// no model calls, no page reads. A run that finds nothing is the normal case and
// the cheap one.
//
// Real clients are swept before internal test orgs, per fleet priority.

const PAUSED = "off";
const AGENT_ID = "00933c46-73ee-4bf5-b8ee-fb56bcedcf71";
// Threads per client per run that get their owner re-pushed even though nothing
// moved, walking forward from where the last run stopped. Catches pushes that
// failed silently at the time; see ThreadOwnerSyncOptions.reassert.
const REASSERT_PER_ORG = 40;
// Pushing to Tenkara is seconds per thread, not milliseconds, so an unbounded
// sweep hits the function ceiling and reports nothing at all (it did, twice).
// Stop starting clients past this and let tomorrow's run continue the walk.
const DEADLINE_MS = 9 * 60 * 1000;
const CURSOR_KEY = (orgId: string) => `reassert_cursor:${orgId}`;

interface OrgRow {
  id: string;
  slug: string | null;
  name: string | null;
  is_internal: boolean | null;
  sourcing_status: string | null;
}

registerAgent({
  slug: "agent-21-thread-owner-sync",
  displayName: "Agent 21 - Thread Owner Sync",
  description:
    "Re-derives the operator on every open email thread and pushes any change to the Tenkara inbox, so the email app never drifts from what Control Room shows. Backstop for owner inputs that change with no operator action (lane/site_type resolution, supplier profiles, claims) and for mirror pushes that failed at the time. Writes draft stamps and Tenkara assignees only: no claims, no leads, no model calls.",
  async run(ctx) {
    const admin = createAdminClient();

    const { data, error } = await admin
      .from("orgs")
      .select("id, slug, name, is_internal, sourcing_status");
    if (error) throw new Error(`could not list orgs: ${error.message}`);

    // A paused org still has open threads an operator may be working, so it is
    // swept too; it just goes last.
    const orgs = ((data ?? []) as OrgRow[]).sort((a, b) => {
      const rank = (o: OrgRow) =>
        (o.is_internal === false ? 0 : 2) + ((o.sourcing_status ?? PAUSED) === PAUSED ? 1 : 0);
      return rank(a) - rank(b) || (a.slug ?? "").localeCompare(b.slug ?? "");
    });

    let examined = 0;
    let moved = 0;
    let reasserted = 0;
    let mirrorsFailed = 0;
    let gone = 0;
    let failedOrgs = 0;
    let skippedOrgs = 0;
    const drifted: string[] = [];
    const startedAt = Date.now();

    for (const org of orgs) {
      const label = org.slug ?? org.name ?? org.id;
      if (Date.now() - startedAt > DEADLINE_MS) {
        skippedOrgs++;
        continue;
      }
      try {
        const { data: state } = await admin
          .from("agent_state")
          .select("value")
          .eq("agent_id", AGENT_ID)
          .eq("key", CURSOR_KEY(org.id))
          .maybeSingle();
        const r = await syncOrgThreadOwners(admin, org.id, {
          reassert: { limit: REASSERT_PER_ORG, after: (state?.value as any)?.cursor ?? null },
        });
        await admin
          .from("agent_state")
          .upsert(
            { agent_id: AGENT_ID, key: CURSOR_KEY(org.id), value: { cursor: r.cursor } },
            { onConflict: "agent_id,key" }
          );
        examined += r.examined;
        moved += r.moved;
        reasserted += r.reasserted;
        mirrorsFailed += r.mirrorsFailed;
        gone += r.gone;
        if (r.moved > 0) {
          drifted.push(`${label} ${r.moved}${r.mirrorsFailed ? ` (${r.mirrorsFailed} not accepted)` : ""}`);
          await ctx.log(`${label}: ${r.moved} of ${r.examined} open threads re-pointed`, {
            step: "sync",
            data: r as any,
          });
        }
      } catch (e: any) {
        // One unreachable org must not stop the sweep: the next org's inbox is
        // just as stale and the retry is a day away.
        failedOrgs++;
        await ctx.log(`${label}: sync failed: ${e.message}`, { step: "sync", level: "error" });
      }
    }

    ctx.setItemsProcessed(moved);
    ctx.setMetadata({ orgs: orgs.length, examined, moved, reasserted, gone, mirrorsFailed, failedOrgs, skippedOrgs });
    ctx.setStatus(failedOrgs || mirrorsFailed || skippedOrgs ? "partial" : "success");
    ctx.setSummary(
      (moved === 0
        ? `Inbox owners match Control Room across ${orgs.length - skippedOrgs} clients (${examined} open threads checked)`
        : `Re-pointed ${moved} of ${examined} open threads: ${drifted.join(", ")}`) +
        ` · re-confirmed ${reasserted} with the inbox` +
        // Not an error: conversations the inbox no longer has. Named so the count
        // is not mistaken for a Tenkara problem, and so a jump in it is visible.
        (gone ? ` · ${gone} no longer exist in the inbox` : "") +
        (mirrorsFailed ? ` · ${mirrorsFailed} the inbox did not accept` : "") +
        (failedOrgs ? ` · ${failedOrgs} clients could not be checked` : "") +
        (skippedOrgs ? ` · ${skippedOrgs} clients left for the next run (time)` : "") +
        ".",
    );
  },
});
