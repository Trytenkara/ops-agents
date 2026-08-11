// Per-org pipeline cadence — how frequently each agent processes each org.
//
// Tiers (orgs.pipeline_tier, toggled in Control Room):
//   testing        — internal test orgs only: near-instant pipeline
//   high_frequency — real clients being actively sourced
//   normal         — standard cadence for everyone else
//
// Intervals are the minimum time between agent runs for a given org. The pinger
// fires every 1 min globally; agents read agent_org_timing and skip orgs whose
// interval hasn't elapsed yet.
//
// NOT called "motherlode": orgs.onboarding_stage already uses that word for the
// unrelated wide-net lead-quality bar, and the collision caused real misreads.

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type PipelineTier = "testing" | "high_frequency" | "normal";

export const PIPELINE_TIERS: readonly PipelineTier[] = ["testing", "high_frequency", "normal"];

// Minimum interval between runs per agent per tier.
const INTERVALS: Record<PipelineTier, Partial<Record<string, number>>> = {
  testing: {
    "agent-03-lead-creator": MINUTE,
    "agent-04-outreach": 5 * MINUTE,
    "agent-05-marketplace-validation": HOUR,
    "agent-06-enrichment": 5 * MINUTE,
    "agent-15-reply-manager": 5 * MINUTE,
  },
  high_frequency: {
    "agent-03-lead-creator": 15 * MINUTE,
    "agent-04-outreach": 15 * MINUTE,
    "agent-05-marketplace-validation": 6 * HOUR,
    "agent-06-enrichment": 15 * MINUTE,
    "agent-15-reply-manager": 10 * MINUTE,
  },
  normal: {
    "agent-03-lead-creator": 2 * HOUR,
    "agent-04-outreach": HOUR,
    "agent-05-marketplace-validation": 24 * HOUR,
    "agent-06-enrichment": HOUR,
    "agent-15-reply-manager": 30 * MINUTE,
  },
};

function intervalMs(tier: PipelineTier, agentSlug: string): number {
  return INTERVALS[tier][agentSlug] ?? HOUR;
}

// Load pipeline_tier for a set of orgs. Anything unreadable or unset reads as
// 'normal' — the slow tier, so a failed lookup can never accidentally speed an
// org up or burn API budget.
export async function loadOrgTiers(
  admin: Admin,
  orgIds: string[]
): Promise<Map<string, PipelineTier>> {
  if (!orgIds.length) return new Map();
  const { data } = await admin.from("orgs").select("id, pipeline_tier").in("id", orgIds);
  return new Map(
    (data ?? []).map((r: any) => [
      r.id as string,
      (PIPELINE_TIERS.includes(r.pipeline_tier) ? r.pipeline_tier : "normal") as PipelineTier,
    ])
  );
}

// Which of the given orgs are due to run this agent, per their tier's interval.
// Orgs with no timing row have never run and are always due.
export async function loadDueOrgIds(
  admin: Admin,
  agentSlug: string,
  orgIds: string[]
): Promise<string[]> {
  if (!orgIds.length) return [];
  const [{ data: timingRows }, tiers] = await Promise.all([
    admin
      .from("agent_org_timing")
      .select("org_id, last_run_at")
      .eq("agent_slug", agentSlug)
      .in("org_id", orgIds),
    loadOrgTiers(admin, orgIds),
  ]);
  const lastRun = new Map(
    (timingRows ?? []).map((r: any) => [r.org_id as string, new Date(r.last_run_at).getTime()])
  );
  const now = Date.now();
  return orgIds.filter((id) => {
    const last = lastRun.get(id);
    if (last === undefined) return true;
    return now - last >= intervalMs(tiers.get(id) ?? "normal", agentSlug);
  });
}

// Upsert last_run_at = now for each processed org.
export async function recordOrgRuns(
  admin: Admin,
  agentSlug: string,
  orgIds: string[]
): Promise<void> {
  if (!orgIds.length) return;
  const now = new Date().toISOString();
  await admin.from("agent_org_timing").upsert(
    orgIds.map((org_id) => ({ agent_slug: agentSlug, org_id, last_run_at: now })),
    { onConflict: "agent_slug,org_id" }
  );
}
