import type { SupabaseClient } from "@supabase/supabase-js";
import { API_COST_RATES, estimateCostUsd, type ProviderRate } from "@/lib/api-cost-rates";

export interface ProviderUsage {
  rate: ProviderRate;
  firedOk30d: number;
  firedOkAll: number;
  firedFailedAll: number;
  leadsLanded: number;
  estCost30d: number;
  estCostAll: number;
}

// Fired discovery calls are durably logged in agent_run_events by Agent 03:
// step = 'importyeti' | 'sourceready', level = 'info' (accepted) | 'warn' (failed).
// Landed leads are counted from leads_in_flight.source. All counts use head:true
// so only the count crosses the wire. Backed by the partial index added in
// migration 0055 (agent_run_events step/level/at where step in the two providers).
export async function getApiUsage(admin: SupabaseClient): Promise<ProviderUsage[]> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const keys = Object.keys(API_COST_RATES) as ProviderRate["key"][];

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

  const countLeads = async (source: string) => {
    const { count } = await admin
      .from("leads_in_flight")
      .select("id", { count: "exact", head: true })
      .eq("source", source);
    return count ?? 0;
  };

  return Promise.all(
    keys.map(async (key) => {
      const [firedOk30d, firedOkAll, firedFailedAll, leadsLanded] = await Promise.all([
        countEvents(key, "info", since30d),
        countEvents(key, "info"),
        countEvents(key, "warn"),
        countLeads(key),
      ]);
      return {
        rate: API_COST_RATES[key],
        firedOk30d,
        firedOkAll,
        firedFailedAll,
        leadsLanded,
        estCost30d: estimateCostUsd(key, firedOk30d),
        estCostAll: estimateCostUsd(key, firedOkAll),
      };
    }),
  );
}
