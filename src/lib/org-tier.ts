// Per-org pipeline tier — controls how frequently each agent processes each org.
//
// Tiers:
//   testing   — fast follow-ups + fast pipeline (FAST_TRACK_ORG_IDS, e.g. Sierra)
//   motherlode — fast pipeline, professional follow-up cadence (MOTHERLODE_ORG_IDS,
//                e.g. Aurora/Bobber, California Chemicals)
//   normal    — standard cadence for orgs not explicitly tiered
//
// Intervals are the minimum time between agent runs for a given org. The pinger
// fires every 1 min globally; agents read agent_org_timing and skip orgs whose
// interval hasn't elapsed yet.

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Tier = "testing" | "motherlode" | "normal";

// Minimum interval between runs per agent per tier.
const INTERVALS: Record<Tier, Partial<Record<string, number>>> = {
  testing: {
    "agent-03-lead-creator": MINUTE,
    "agent-04-outreach": 5 * MINUTE,
    "agent-05-marketplace-validation": HOUR,
    "agent-06-enrichment": 5 * MINUTE,
    "agent-15-reply-manager": 5 * MINUTE,
  },
  motherlode: {
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

function parseIds(env: string | undefined): Set<string> {
  return new Set((env ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function getOrgTier(orgId: string): Tier {
  if (parseIds(process.env.FAST_TRACK_ORG_IDS).has(orgId)) return "testing";
  if (parseIds(process.env.MOTHERLODE_ORG_IDS).has(orgId)) return "motherlode";
  return "normal";
}

function getIntervalMs(orgId: string, agentSlug: string): number {
  const tier = getOrgTier(orgId);
  return INTERVALS[tier][agentSlug] ?? HOUR;
}

// Load last-run timestamps for a given agent across a set of orgs.
// Returns a map of org_id → Date.
export async function loadOrgTimingMap(
  admin: Admin,
  agentSlug: string,
  orgIds: string[]
): Promise<Map<string, Date>> {
  if (!orgIds.length) return new Map();
  const { data } = await admin
    .from("agent_org_timing")
    .select("org_id, last_run_at")
    .eq("agent_slug", agentSlug)
    .in("org_id", orgIds);
  return new Map((data ?? []).map((r: any) => [r.org_id, new Date(r.last_run_at)]));
}

// Given a preloaded timing map, returns which org IDs from the input are due.
// Orgs with no timing entry are always due (never run before).
export function filterDueOrgIds(
  orgIds: string[],
  timingMap: Map<string, Date>,
  agentSlug: string
): string[] {
  const now = Date.now();
  return orgIds.filter((id) => {
    const last = timingMap.get(id);
    if (!last) return true;
    return now - last.getTime() >= getIntervalMs(id, agentSlug);
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
