import type { createAdminClient } from "@/lib/supabase/admin";
import { onlyOrgNames } from "@/lib/org-scope";

// Per-org sourcing pause switch (see migration 0045). Live, DB-driven, toggled
// by ops in the Control Room — supersedes the env-only ONLY_ORG scoping.
//   active        → full pipeline (discovery, enrichment, outreach, replies, re-quote)
//   sourcing_only → discovery + enrichment only; outreach/replies/re-quote held
//   off           → agents skip this org entirely
export type SourcingStatus = "active" | "sourcing_only" | "off";

const VALID: SourcingStatus[] = ["active", "sourcing_only", "off"];
export function normalizeStatus(v: unknown): SourcingStatus {
  return VALID.includes(v as SourcingStatus) ? (v as SourcingStatus) : "off";
}

// Discovery + enrichment may build this org's supplier pool.
export function sourcingAllowed(s: SourcingStatus): boolean {
  return s === "active" || s === "sourcing_only";
}
// Outreach, no-reply follow-ups, and quote re-validation may act for this org.
export function outreachAllowed(s: SourcingStatus): boolean {
  return s === "active";
}

type Admin = ReturnType<typeof createAdminClient>;

export interface OrgStatuses {
  byOaId: Map<string, SourcingStatus>;
  byTenkaraId: Map<string, SourcingStatus>;
  byName: Map<string, SourcingStatus>;
  // Names allowed at each capability level — handy for building SQL `= ANY()` filters.
  sourcingNames: string[];
  outreachNames: string[];
}

// Load every org's sourcing status. ONLY_ORG (if still set) is honored as an
// AND-override during rollout: an org not in ONLY_ORG is forced to 'off'
// regardless of its stored status, so the env var can't be silently bypassed
// until it's retired. Once ONLY_ORG is unset the stored status is authoritative.
export async function loadOrgStatuses(admin: Admin): Promise<OrgStatuses> {
  const only = new Set(onlyOrgNames());
  const { data } = await admin.from("orgs").select("id, name, tenkara_org_id, sourcing_status");

  const byOaId = new Map<string, SourcingStatus>();
  const byTenkaraId = new Map<string, SourcingStatus>();
  const byName = new Map<string, SourcingStatus>();
  const sourcingNames: string[] = [];
  const outreachNames: string[] = [];

  for (const r of (data ?? []) as { id: string; name: string; tenkara_org_id: string | null; sourcing_status: string | null }[]) {
    let status = normalizeStatus(r.sourcing_status);
    if (only.size && !only.has(r.name)) status = "off";
    byOaId.set(r.id, status);
    if (r.tenkara_org_id) byTenkaraId.set(r.tenkara_org_id, status);
    byName.set(r.name, status);
    if (sourcingAllowed(status)) sourcingNames.push(r.name);
    if (outreachAllowed(status)) outreachNames.push(r.name);
  }
  return { byOaId, byTenkaraId, byName, sourcingNames, outreachNames };
}
