import type { SupabaseClient } from "@supabase/supabase-js";
import { getSourcingExclusions, hostOf, normalizeCompanyName } from "@/lib/tenkara-sourcing-exclusions";
import { selectAllPaged } from "@/lib/supabase-paging";

// "Never contact this company again for this client" has two authors:
//
//  - the client, in their own Tenkara settings (read read-only), and
//  - ops, in supplier_do_not_contact.
//
// Both used to be honoured only at discovery and cold-outreach candidate
// selection, so anything already in flight (follow-ups, check-ins, replies)
// kept emailing a company the client had asked us to leave alone. This is the
// one place that answers "are we allowed to email this company at all", and it
// is consulted at draft time, which every outreach path goes through.

export interface DncQuery {
  orgId: string | null;
  tenkaraOrgId?: string | null;
  supplierId?: string | null;
  companyName?: string | null;
  website?: string | null;
  email?: string | null;
}

export interface DncVerdict {
  blocked: boolean;
  /** "dnc_ops" or "dnc_client" */
  source?: string;
  reason?: string | null;
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

// One Tenkara round trip per org per run, not one per draft.
const clientCache = new Map<string, { at: number; ex: Awaited<ReturnType<typeof getSourcingExclusions>> }>();
const CLIENT_TTL_MS = 5 * 60 * 1000;

const tenkaraIdCache = new Map<string, string | null>();

/** The client's Tenkara org id, needed to read their own do-not-contact list. */
export async function tenkaraOrgIdFor(
  admin: SupabaseClient<any, any, any>,
  orgId: string
): Promise<string | null> {
  if (tenkaraIdCache.has(orgId)) return tenkaraIdCache.get(orgId) ?? null;
  const { data } = await admin.from("orgs").select("tenkara_org_id").eq("id", orgId).maybeSingle();
  const v = ((data as any)?.tenkara_org_id as string | null) ?? null;
  tenkaraIdCache.set(orgId, v);
  return v;
}

export async function isDoNotContact(
  admin: SupabaseClient<any, any, any>,
  q: DncQuery
): Promise<DncVerdict> {
  if (!q.orgId) return { blocked: false };

  const nameKey = normalizeCompanyName(q.companyName);
  const host = hostOf(q.website);
  const email = norm(q.email);
  const supplierId = q.supplierId ? String(q.supplierId) : null;
  if (!supplierId && !nameKey && !host && !email) return { blocked: false };

  // Ops list. Any one identifier matching is a block: a company we blocked by
  // name is the same company when it later arrives carrying a supplier id.
  // Matched in JS rather than in the query, because company names carry commas
  // and brackets, which are the separators in a PostgREST or-filter.
  // PERS-06: a do-not-contact list is the one read where a window is never
  // acceptable — the 1,001st entry would simply be contacted, and at exactly
  // the PostgREST page size an accidental truncation would look identical to
  // the cap. Paged to the end over the primary key.
  const data = await selectAllPaged<any>((from, to) =>
    admin
      .from("supplier_do_not_contact")
      .select("supplier_id, name_key, host, email, reason")
      .eq("org_id", q.orgId!)
      .is("removed_at", null)
      .order("id")
      .range(from, to)
  ).catch((e: any) => {
    console.warn(`[do-not-contact] ops list read failed for org ${q.orgId}: ${e?.message ?? e}`);
    return null;
  });
  if (data?.length) {
    for (const row of data as any[]) {
      const match =
        (supplierId && row.supplier_id && String(row.supplier_id) === supplierId) ||
        (nameKey && norm(row.name_key) === nameKey) ||
        (host && norm(row.host) === host) ||
        (email && norm(row.email) === email);
      if (match) return { blocked: true, source: "dnc_ops", reason: row.reason ?? null };
    }
  }

  // Client list. Fail open: if Tenkara is unreachable we do not want every
  // draft in the fleet to stop, and discovery still applies the same list.
  if (q.tenkaraOrgId) {
    try {
      const hit = clientCache.get(q.tenkaraOrgId);
      const fresh = hit && Date.now() - hit.at < CLIENT_TTL_MS;
      const ex = fresh ? hit!.ex : await getSourcingExclusions(q.tenkaraOrgId);
      if (!fresh) clientCache.set(q.tenkaraOrgId, { at: Date.now(), ex });
      if ((host && ex.dncHosts.has(host)) || (nameKey && ex.dncNames.has(nameKey))) {
        return { blocked: true, source: "dnc_client", reason: null };
      }
    } catch {
      // fail open
    }
  }

  return { blocked: false };
}
