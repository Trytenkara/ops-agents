import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshStaleClientProfiles } from "@/lib/client-profile";
import { syncAllClientSettings } from "@/lib/tenkara-client-settings";
import { recheckOrgLeads } from "@/lib/requirements-recheck";
import { sortByOrgPriority } from "@/lib/org-priority";

// Wall-clock this run will spend re-judging leads after a requirements change.
// Deliberately a small slice of the 300s this agent's invocation gets: the
// research sweep below already times out on its own sometimes, and starving it
// would trade one stale thing for another. The re-check is resumable and runs
// every cycle, so a small slice per run still drains a large backlog quickly;
// anything not reached keeps its old fingerprint and is picked up next cycle.
const RECHECK_BUDGET_MS = 45_000;

// Agent 12 - Client Profile.
//
// Profiles are generated on demand (the "Generate / Refresh" button on each
// org's Client Profile tab) and whenever ops upload info. This scheduled run
// is a LIGHT backstop: it re-researches a few stale or missing profiles per
// run (web_search is costly, so it's capped). It respects ops edits
// (manual_override) — only an explicit regen overrides those.
//
// OA writes only; Tenkara is read-only and best-effort.

registerAgent({
  slug: "agent-12-client-profile",
  displayName: "Agent 12 - Client Profile",
  description:
    "Keeps client settings and profiles current. Every run: mirrors each client's Tenkara settings (ship-to, billing/samples addresses, UoM, country exclusions, qualification rules) into OA. Backstop sweep: re-researches a few stale/missing profiles per run (web_search + Tenkara + settings + uploads, summarized). OA-only.",
  async run(ctx) {
    const admin = createAdminClient();

    // Step 1 - mirror Tenkara's client settings. Every org, every run, no LLM.
    // Kept ahead of (and independent of) the research sweep so a ship-to change
    // in Tenkara lands within the hour even when the profile itself is stale,
    // manually overridden, or the research below fails outright.
    let sync;
    try {
      sync = await syncAllClientSettings(admin);
      await ctx.log(
        `Settings sync: ${sync.synced}/${sync.considered} orgs${sync.changed ? ` · ${sync.changed} changed (${sync.changedOrgs.join(", ")})` : ""}${sync.errored ? ` · ${sync.errored} errors` : ""}`,
        { step: "settings_sync", data: sync as any }
      );
    } catch (e: any) {
      await ctx.log(`Settings sync failed: ${e.message}`, { level: "error", step: "settings_sync" });
    }

    // Step 1b - re-judge existing leads for any client whose requirements moved.
    // Without this, a dealbreaker grade added today only ever applies to leads
    // discovered after today: the verdict on existing leads is frozen at
    // enrichment and the enrichment claim only ever sees stage='raw'. No LLM, no
    // web, no credits — it recomputes from evidence already on the payload.
    let rechecked = 0;
    if (sync?.requirementsChangedOrgs?.length) {
      const ids = sync.requirementsChangedOrgs.map((o) => o.orgId);
      const { data: orgRows } = await admin
        .from("orgs")
        .select("id, name, tenkara_org_id, onboarding_stage, is_internal, sourcing_status")
        .in("id", ids);
      const byId = new Map((orgRows ?? []).map((o: any) => [o.id, o]));
      // Real clients before internal test orgs, and orgs the fleet is actually
      // working before parked ones: this shares the run's wall clock with the
      // research sweep below, so the capacity drains in that order.
      const queue = sortByOrgPriority([...sync.requirementsChangedOrgs], (i) => byId.get(i.orgId));
      const budgetEndsAt = Date.now() + RECHECK_BUDGET_MS;
      for (const item of queue) {
        const org = byId.get(item.orgId);
        if (!org) continue;
        const remaining = budgetEndsAt - Date.now();
        if (remaining < 5_000) {
          await ctx.log(`Requirements re-check budget spent; ${queue.length - rechecked} org(s) deferred to the next run`, {
            step: "requirements_recheck",
          });
          break;
        }
        const summary = await recheckOrgLeads(admin, org as any, {
          reason: "client requirements changed",
          deadlineMs: remaining,
        }).catch((e: any) => ({ orgId: item.orgId, scanned: 0, updated: 0, verdictChanged: 0, barChanged: 0, truncated: true, error: e?.message ?? String(e) }));
        rechecked++;
        await ctx.log(
          `Requirements re-check for ${org.name ?? item.orgId}: ${summary.updated} of ${summary.scanned} lead(s) updated (${summary.verdictChanged} dealbreaker verdict, ${summary.barChanged} onboarded bar)${summary.truncated ? " · incomplete, resumes next run" : ""}${summary.error ? ` · ${summary.error}` : ""}`,
          { level: summary.error ? "warn" : "info", step: "requirements_recheck", data: summary as any }
        );
        // Only record the fingerprint on a COMPLETE pass, so a truncated one is
        // picked up again next cycle instead of being marked done.
        if (!summary.truncated && !summary.error) {
          await admin
            .from("client_tenkara_settings")
            .update({ requirements_hash: item.hash, requirements_checked_at: new Date().toISOString() })
            .eq("org_id", item.orgId);
        }
      }
    }

    // Step 2 - the costly research backstop.
    let res;
    try {
      res = await refreshStaleClientProfiles(admin, { runId: ctx.runId, limit: 3 });
    } catch (e: any) {
      await ctx.log(`Refresh failed: ${e.message}`, { level: "error", step: "refresh" });
      ctx.setStatus("failure");
      ctx.setSummary(`Refresh failed: ${e.message}`);
      return;
    }

    const syncNote = sync ? `Synced settings for ${sync.synced} client(s)${sync.changed ? ` · ${sync.changed} changed` : ""}${rechecked ? ` · re-checked leads for ${rechecked} client(s) whose requirements changed` : ""}. ` : "";
    ctx.setItemsProcessed(res.generated);
    ctx.setStatus(res.errored > 0 && res.generated === 0 ? "failure" : res.errored > 0 ? "partial" : "success");
    ctx.setSummary(
      syncNote +
        (res.considered === 0
          ? "No clients to profile yet."
          : `Researched ${res.generated} stale profile(s)${res.skipped ? ` · ${res.skipped} skipped (edited)` : ""}${res.errored ? ` · ${res.errored} errors` : ""} of ${res.considered} clients.`)
    );
  },
});
