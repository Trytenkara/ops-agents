import type { SupabaseClient } from "@supabase/supabase-js";
import { API_COST_RATES, CONTACT_PROVIDER_KEYS, estimateCostUsd, type ProviderRate } from "@/lib/api-cost-rates";

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
// never wrote back are not counted). Paid contact providers (Hunter, LeadMagic,
// ZoomInfo, GetProspect) are journaled per call by Agent 06 into the same table
// and summed by the contact_api_usage() function. All plain counts use head:true.
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

  // Paid contact providers. Units are BILLABLE UNITS, not calls — one Hunter
  // Domain Search can reveal several emails at 1 credit each, and one ZoomInfo
  // enrich call can bill several contacts. Summed server-side by the
  // contact_api_usage() function (migration 0077), which also keeps the sum
  // clear of the PostgREST 1000-row page cap.
  const contact = (async (): Promise<ProviderUsage[]> => {
    const [all, recent] = await Promise.all([
      admin.rpc("contact_api_usage", { since: null }),
      admin.rpc("contact_api_usage", { since: since30d }),
    ]);
    const byKey = (rows: any) => new Map<string, any>((Array.isArray(rows) ? rows : []).map((r: any) => [r.provider, r]));
    const allBy = byKey(all.data);
    const recentBy = byKey(recent.data);

    return Promise.all(
      CONTACT_PROVIDER_KEYS.map(async (key) => {
        const a = allBy.get(key);
        const r = recentBy.get(key);
        const unitsAll = Number(a?.units ?? 0);
        const units30d = Number(r?.units ?? 0);
        // Leads this provider actually resolved the primary contact for — the
        // hit-rate half of the picture the unit counts alone don't show.
        const { count } = await admin
          .from("leads_in_flight")
          .select("id", { count: "exact", head: true })
          .eq("payload->enrichment->contact->>source", key);
        return {
          rate: API_COST_RATES[key],
          units30d,
          unitsAll,
          failedAll: Number(a?.failed ?? 0),
          leads: count ?? 0,
          estCost30d: estimateCostUsd(key, units30d),
          estCostAll: estimateCostUsd(key, unitsAll),
        } satisfies ProviderUsage;
      })
    );
  })();

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

  const [discoveryRows, browserbaseRow, contactRows] = await Promise.all([
    Promise.all(discovery),
    browserbase,
    contact,
  ]);
  return [...discoveryRows, browserbaseRow, ...contactRows];
}
