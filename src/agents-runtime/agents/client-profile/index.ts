import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { refreshStaleClientProfiles } from "@/lib/client-profile";
import { syncAllClientSettings } from "@/lib/tenkara-client-settings";

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

    const syncNote = sync ? `Synced settings for ${sync.synced} client(s)${sync.changed ? ` · ${sync.changed} changed` : ""}. ` : "";
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
