import type { SupabaseClient } from "@supabase/supabase-js";
import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Match a supplier name against the suppliers THIS CLIENT has in Tenkara, and
// return that supplier's id. Used at discovery and at first draft, so a lead
// carries the client's own supplier record rather than a name alone.
//
// The client is not optional. Tenkara holds one suppliers table for every
// client, names collide constantly (1,555 normalized names cover 3,302 rows,
// and 1,554 of those groups span more than one client), and this function used
// to match on name across the whole table and take the first row it saw. That
// labelled 907 of 3,141 conversations with another client's supplier record:
// same company name, wrong client. Ownership, quotes and profiles all hang off
// that record, so the mislabel spreads.
//
// A client that has no record of the company resolves to null, which is the
// honest answer and leaves the lead name-only. Guessing at the nearest row is
// what produced the 907.

interface TenkaraSupplierRow {
  id: string;
  name: string;
  organization_ids: string[] | null;
}

const normName = (s: string | null | undefined): string => {
  if (!s) return "";
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "") // strip punctuation
    .replace(/\s+/g, " ") // normalize whitespace
    .trim();
};

// `${tenkaraOrgId}|${normalizedName}` → supplier id. Keying by client is what
// makes a cross-client match impossible rather than merely discouraged.
let _supplierCache: Map<string, string> | null = null;
// supplier id -> { the clients that own it, its name }. Answers "may this client
// hold this id", which a caller handing us an id already has to ask.
let _supplierOwners: Map<string, { orgs: Set<string>; name: string }> | null = null;
// OA org id → Tenkara organization id. Callers hold the OA id, so resolving it
// here keeps the client argument to the one id every caller already has.
const _orgIdCache = new Map<string, string | null>();

function scopedKey(tenkaraOrgId: string, name: string): string {
  return `${tenkaraOrgId}|${name}`;
}

async function loadSupplierCache(): Promise<Map<string, string>> {
  if (_supplierCache) return _supplierCache;
  const cache = new Map<string, string>();
  const owners = new Map<string, { orgs: Set<string>; name: string }>();
  try {
    const suppliers = await tenkaraQuery<TenkaraSupplierRow>(
      `SELECT id, name, organization_ids FROM public.suppliers ORDER BY name`
    );
    for (const s of suppliers) {
      owners.set(s.id, { orgs: new Set((s.organization_ids ?? []).filter(Boolean).map(String)), name: s.name });
      const name = normName(s.name);
      if (!name) continue;
      // A supplier with no client owns no lead. Skipping it is deliberate: it
      // cannot be matched to anyone, so caching it under a blank client would
      // reintroduce the unscoped lookup.
      for (const org of s.organization_ids ?? []) {
        if (!org) continue;
        const key = scopedKey(String(org), name);
        if (!cache.has(key)) cache.set(key, s.id);
      }
    }
    _supplierCache = cache;
    _supplierOwners = owners;
  } catch (e) {
    // A Tenkara outage must not block discovery. An empty cache resolves every
    // name to null, which is the same as not knowing the id yet.
    console.error("Failed to load Tenkara supplier cache:", e);
    _supplierCache = new Map();
    _supplierOwners = new Map();
  }
  return _supplierCache;
}

async function tenkaraOrgIdFor(admin: SupabaseClient, orgId: string): Promise<string | null> {
  if (_orgIdCache.has(orgId)) return _orgIdCache.get(orgId) ?? null;
  const { data } = await admin.from("orgs").select("tenkara_org_id").eq("id", orgId).maybeSingle();
  const tenkaraOrgId = (data?.tenkara_org_id as string | null) ?? null;
  _orgIdCache.set(orgId, tenkaraOrgId);
  return tenkaraOrgId;
}

export async function resolveSupplierIdByName(
  admin: SupabaseClient,
  orgId: string | null | undefined,
  supplierName: string | null | undefined
): Promise<string | null> {
  if (!orgId || !supplierName) return null;
  const name = normName(supplierName);
  if (!name) return null;
  // A client we cannot place in Tenkara has no supplier list to match against.
  // Falling back to a fleet-wide match here would be the original bug.
  const tenkaraOrgId = await tenkaraOrgIdFor(admin, orgId);
  if (!tenkaraOrgId) return null;
  const cache = await loadSupplierCache();
  return cache.get(scopedKey(tenkaraOrgId, name)) ?? null;
}

// The supplier id this client is allowed to store, given an id someone handed us
// and the company's name.
//
// Scoping the NAME lookup was only half the fault. An id already in hand was
// still trusted, and quote rows carry a supplier id resolved for whoever quoted
// the material, which is not always the client we are drafting for. That is how a
// California Chemicals thread ended up holding a "Level 7 Chemical" record owned
// by nobody, hours after the name lookup was scoped. So an id is checked against
// `organization_ids` before it is written, and an id this client may not hold
// falls back to their own record of the same company, or to null.
export async function scopedSupplierId(
  admin: SupabaseClient,
  orgId: string | null | undefined,
  supplierId: string | null | undefined,
  supplierName: string | null | undefined
): Promise<string | null> {
  if (!orgId) return null;
  const tenkaraOrgId = await tenkaraOrgIdFor(admin, orgId);
  if (!tenkaraOrgId) return null;
  await loadSupplierCache();
  const owner = supplierId ? _supplierOwners?.get(supplierId) : null;
  if (owner?.orgs.has(String(tenkaraOrgId))) return supplierId ?? null;
  // The name on the record we were pointed at beats the caller's label: the
  // caller's can be a marketplace listing title, the record's is the company.
  return resolveSupplierIdByName(admin, orgId, owner?.name ?? supplierName);
}

// Clear caches — use sparingly, e.g. if Tenkara schema changes.
export function clearSupplierCache() {
  _supplierCache = null;
  _supplierOwners = null;
  _orgIdCache.clear();
}
