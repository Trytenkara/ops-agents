import type { SupabaseClient } from "@supabase/supabase-js";
import { API_COST_RATES, estimateCostUsd, type ProviderRate } from "@/lib/api-cost-rates";

export interface ProviderUsage {
  rate: ProviderRate;
  units30d: number | null; // billable units in last 30d (null = not windowable here)
  unitsAll: number;
  failedAll: number | null; // failed fires (null = n/a for this provider)
  leads: number | null; // leads landed/processed (null = n/a)
  estCost30d: number | null;
  estCostAll: number;
}

// Discovery calls (ImportYeti, SourceReady) are durably logged in agent_run_events
// by Agent 03: step = provider key, level = 'info' (accepted) | 'warn' (failed).
// Backed by the partial index in migration 0055. Browserbase price-pull runs as a
// standalone Agent 05 skill (no agent_run_events), so its sessions are counted from
// leads_in_flight.payload.marketplace_pull.source = 'browserbase_login' — a rough,
// all-time proxy (payload is overwritten on re-pull, and errored sessions that
// never wrote back are not counted). All counts use head:true.
export async function getApiUsage(admin: SupabaseClient): Promise<ProviderUsage[]> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const countEvents = async (step: string, level: string, since?: string) => {
    let q = admin
      .from("agent_run_events")
      .select("id", { count: "exact", head: true })
      .eq("step", step)
      .eq("level", level);
    if (since) q = q.gte("at", since);
    const { count } = await q;
    return count ?? 0;
  };

  const countLeadsBySource = async (source: string) => {
    const { count } = await admin
      .from("leads_in_flight")
      .select("id", { count: "exact", head: true })
      .eq("source", source);
    return count ?? 0;
  };

  const countBrowserbaseSessions = async () => {
    const { count } = await admin
      .from("leads_in_flight")
      .select("id", { count: "exact", head: true })
      .eq("payload->marketplace_pull->>source", "browserbase_login");
    return count ?? 0;
  };

  const discovery = (["sourceready", "importyeti"] as ProviderRate["key"][]).map(async (key) => {
    const [ok30d, okAll, failedAll, leads] = await Promise.all([
      countEvents(key, "info", since30d),
      countEvents(key, "info"),
      countEvents(key, "warn"),
      countLeadsBySource(key),
    ]);
    return {
      rate: API_COST_RATES[key],
      units30d: ok30d,
      unitsAll: okAll,
      failedAll,
      leads,
      estCost30d: estimateCostUsd(key, ok30d),
      estCostAll: estimateCostUsd(key, okAll),
    } satisfies ProviderUsage;
  });

  const browserbase = (async () => {
    const sessions = await countBrowserbaseSessions();
    return {
      rate: API_COST_RATES.browserbase,
      units30d: null,
      unitsAll: sessions,
      failedAll: null,
      leads: null,
      estCost30d: null,
      estCostAll: estimateCostUsd("browserbase", sessions),
    } satisfies ProviderUsage;
  })();

  return Promise.all([...discovery, browserbase]);
}
