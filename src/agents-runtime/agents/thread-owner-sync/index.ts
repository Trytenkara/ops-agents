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
    let mirrorsFailed = 0;
    let failedOrgs = 0;
    const drifted: string[] = [];

    for (const org of orgs) {
      const label = org.slug ?? org.name ?? org.id;
      try {
        const r = await syncOrgThreadOwners(admin, org.id);
        examined += r.examined;
        moved += r.moved;
        mirrorsFailed += r.mirrorsFailed;
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
    ctx.setMetadata({ orgs: orgs.length, examined, moved, mirrorsFailed, failedOrgs });
    ctx.setStatus(failedOrgs || mirrorsFailed ? "partial" : "success");
    ctx.setSummary(
      moved === 0 && !failedOrgs
        ? `Inbox owners match Control Room across ${orgs.length} clients (${examined} open threads checked).`
        : `Re-pointed ${moved} of ${examined} open threads: ${drifted.join(", ") || "none"}` +
            (mirrorsFailed ? ` · ${mirrorsFailed} the inbox did not accept` : "") +
            (failedOrgs ? ` · ${failedOrgs} clients could not be checked` : ""),
    );
  },
});
