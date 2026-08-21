// Work the fleet flagged for a person, and where a person can see it.
//
// Four kinds of flag are computed every day — a price the publish gate took
// away, a quote captured with no price, a contact address nobody tested, an
// audit finding — and until 2026-08-21 not one of them was rendered on the
// owning client's workspace. The reasons were computed, stored, and read by
// nothing. A flag nobody can see is worse than no flag: the price-index tab
// shows a blank cell, which reads as "nobody has got to this yet", so the row
// waits forever for an operator who was never told (PERS-07, UI-06).
//
// This registry is the fix and the constraint. A flagged set that is not
// declared here has no surface, so declaring it here is what gives it one: the
// panel renders whatever this array holds and knows none of the keys by name.

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export interface FlaggedItem {
  id: string;
  /** Supplier × material, or whatever names the thing an operator has to find. */
  title: string;
  /** Why it is flagged, in the words of whatever flagged it. Never empty. */
  reason: string;
  at: string | null;
}

export interface FlaggedGroup {
  key: string;
  label: string;
  rule: string;
  description: string;
  /** Where the operator goes to act on it, relative to the org workspace. */
  href: string;
  items: FlaggedItem[];
  /** Every row that matched, not just the ones listed. Caps are never silent (PERS-06). */
  total: number;
}

export interface FlaggedSet {
  key: string;
  label: string;
  rule: string;
  description: string;
  /** `slug` is the org slug; the panel prefixes nothing. */
  href: (slug: string) => string;
  load: (admin: Admin, orgId: string) => Promise<{ items: FlaggedItem[]; total: number }>;
}

// Enough rows to show the shape of the problem. The count beside it is exact,
// so a truncated list still says how much work there is.
const SHOW = 25;

const pair = (supplier: string | null | undefined, material: string | null | undefined) =>
  [supplier?.trim() || "Unnamed supplier", material?.trim() || "unknown material"].join(" × ");

export const FLAGGED_SETS: FlaggedSet[] = [
  {
    key: "withheld_price",
    label: "Prices withheld from a listing",
    rule: "PERS-07",
    description:
      "The page was read and a number came back, but it could not be published: unreadable, negative, implausible, or quoted in a currency with no rate to convert it. The listing is live and the price is knowable, so this is work an operator can finish today.",
    href: (slug) => `/work/orgs/${slug}/price-index`,
    load: async (admin, orgId) => {
      const { data, count } = await admin
        .from("leads_in_flight")
        .select("id, supplier_name, material_name, payload", { count: "exact" })
        .eq("org_id", orgId)
        .eq("status", "active")
        .eq("payload->marketplace_pull->>withheld", "true")
        .order("payload->marketplace_pull->>withheld_at", { ascending: true, nullsFirst: true })
        .limit(SHOW);
      const items = (data ?? []).map((l: any) => ({
        id: l.id,
        title: pair(l.supplier_name, l.material_name),
        reason: l.payload?.marketplace_pull?.withheld_reason ?? "withheld with no reason recorded",
        at: l.payload?.marketplace_pull?.withheld_at ?? null,
      }));
      return { items, total: count ?? items.length };
    },
  },
  {
    key: "withheld_quote",
    label: "Quotes captured with no price",
    rule: "PERS-07",
    description:
      "A supplier reply or attachment was read as a quote, but the figure in it could not be trusted — the words it was read from do not contain it, the currency was never stated, or the basis was assumed. The supplier already answered, so the price is one reply away.",
    href: (slug) => `/work/orgs/${slug}/price-index`,
    load: async (admin, orgId) => {
      const { data, count } = await admin
        .from("staged_quotes")
        .select("id, supplier_name, material_name, extraction_notes, created_at", { count: "exact" })
        .eq("org_id", orgId)
        .is("price", null)
        .neq("status", "dismissed")
        .order("created_at", { ascending: false })
        .limit(SHOW);
      const items = (data ?? []).map((q: any) => ({
        id: q.id,
        title: pair(q.supplier_name, q.material_name),
        reason: (q.extraction_notes ?? "").trim() || "withheld with no reason recorded",
        at: q.created_at ?? null,
      }));
      return { items, total: count ?? items.length };
    },
  },
  {
    key: "unverified_contact",
    label: "Contacts nobody tested",
    rule: "DATA-06",
    description:
      "The address on these leads was synthesized from a name and a domain, not read off a page or returned by a provider. Sending to a guess is how a domain earns a bounce reputation, so confirm the address before the first email goes out.",
    href: (slug) => `/work/orgs/${slug}/leads`,
    load: async (admin, orgId) => {
      const { data, count } = await admin
        .from("leads_in_flight")
        .select("id, supplier_name, material_name, payload, created_at", { count: "exact" })
        .eq("org_id", orgId)
        .eq("status", "active")
        .eq("payload->>contact_confidence", "guessed")
        .order("created_at", { ascending: false })
        .limit(SHOW);
      const items = (data ?? []).map((l: any) => ({
        id: l.id,
        title: pair(l.supplier_name, l.material_name),
        reason: `${l.payload?.contact_email ?? "address"} was guessed from the supplier's name and domain; no provider tested it.`,
        at: l.created_at ?? null,
      }));
      return { items, total: count ?? items.length };
    },
  },
];

/**
 * Load every declared set for one org.
 *
 * Iterates the registry rather than naming the sets, so a set added above
 * appears on the client's tab without anyone remembering to wire it up — which
 * is the failure this exists to prevent. One slow query cannot blank the panel:
 * a set that throws reports itself as broken rather than as empty (PERS-03).
 */
export async function loadFlaggedWork(admin: Admin, orgId: string, slug: string): Promise<FlaggedGroup[]> {
  const groups = await Promise.all(
    FLAGGED_SETS.map(async (set) => {
      try {
        const { items, total } = await set.load(admin, orgId);
        return { key: set.key, label: set.label, rule: set.rule, description: set.description, href: set.href(slug), items, total };
      } catch (e: any) {
        return {
          key: set.key,
          label: set.label,
          rule: set.rule,
          description: set.description,
          href: set.href(slug),
          items: [
            {
              id: `${set.key}-error`,
              title: "Could not be counted",
              reason: `This set failed to load: ${e?.message ?? e}. The count below is not zero, it is unknown.`,
              at: null,
            },
          ],
          total: -1,
        };
      }
    })
  );
  return groups;
}
