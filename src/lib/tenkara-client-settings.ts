import type { SupabaseClient } from "@supabase/supabase-js";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { requirementsFingerprint } from "@/lib/requirements-fingerprint";
import {
  fetchRequirementRows,
  type RequirementPhase,
  type RequirementsRow,
} from "@/lib/tenkara-requirements";

// Tenkara -> OA mirror of a client's settings (ship-to, billing/samples
// addresses, UoM, country exclusions, qualification requirements).
//
// Deliberately dumb and deterministic: no LLM, no web research, no caps. That
// is what makes it safe to run on every cycle for every org, which in turn is
// what guarantees a change Ben makes in Tenkara reaches the agents within the
// hour. The expensive LLM profile research (client-profile.ts) stays on its own
// slow, capped, manual_override-respecting cadence.

export interface ShipToAddress {
  company: string | null;
  addressLine: string | null;
  apartment: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}

function str(v: any): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function parseAddress(raw: any): ShipToAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const a: ShipToAddress = {
    company: str(raw.company_name),
    addressLine: str(raw.address_line),
    apartment: str(raw.apartment),
    city: str(raw.city),
    state: str(raw.state),
    zip: str(raw.zip),
    country: str(raw.country),
  };
  // An address with no locality is noise, not a destination.
  return a.city || a.zip || a.addressLine ? a : null;
}

// What we are willing to tell a supplier: enough to quote freight, no street
// line. Keeping the street out is also what keeps these strings clear of
// contact-guard's fabricated-address block (see lib/contact-guard.ts).
export function shipToRegion(a: ShipToAddress | null | undefined): string | null {
  if (!a) return null;
  const locality = [a.city, a.state].filter(Boolean).join(", ");
  const withZip = [locality, a.zip].filter(Boolean).join(" ");
  if (!withZip) return null;
  // Only name the country when it isn't the US, so domestic reads naturally.
  const country = a.country && !/^(us|usa|united states)$/i.test(a.country) ? `, ${a.country}` : "";
  return `${withZip}${country}`;
}

export function formatFullAddress(a: ShipToAddress | null | undefined): string | null {
  if (!a) return null;
  const parts = [
    a.company,
    [a.addressLine, a.apartment].filter(Boolean).join(" "),
    [[a.city, a.state].filter(Boolean).join(", "), a.zip].filter(Boolean).join(" "),
    a.country,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

interface SettingsRow {
  shipping_addresses: any[] | null;
  billing_address: any;
  samples_address: any;
  unit_of_measurement: string | null;
  federal_tax_id: string | null;
  excluded_material_countries: string[] | null;
  excluded_packaging_countries: string[] | null;
  updated_at: string | null;
}

// Tenkara can hold more than one settings row per org (historically one per
// user). Prefer the most recently updated row that actually has a ship-to, so
// an empty stub row can't shadow a configured one.
async function fetchTenkaraSettings(tenkaraOrgId: string): Promise<SettingsRow | null> {
  const rows = await tenkaraQuery<SettingsRow>(
    `select shipping_addresses, billing_address, samples_address, unit_of_measurement,
            federal_tax_id, excluded_material_countries, excluded_packaging_countries,
            updated_at
       from public.user_supplier_settings
      where organization_id = $1::uuid
      order by (coalesce(array_length(shipping_addresses, 1), 0) > 0) desc,
               updated_at desc nulls last
      limit 1`,
    [tenkaraOrgId]
  );
  return rows[0] ?? null;
}

export interface OrgSyncResult {
  orgId: string;
  status: "synced" | "no_tenkara_org" | "no_settings" | "error";
  shipTo?: string | null;
  changed?: boolean;
  // The client's requirements (dealbreaker grades, certs, exclusions, material
  // list) differ from the ones their existing leads were last judged against, so
  // those leads need re-checking. Carries the new fingerprint to record once a
  // re-check completes. Null when the fingerprint could not be read.
  requirementsChanged?: boolean;
  requirementsHash?: string | null;
  error?: string;
}

export async function syncClientSettingsForOrg(
  admin: SupabaseClient,
  org: { id: string; tenkara_org_id: string | null }
): Promise<OrgSyncResult> {
  if (!org.tenkara_org_id) return { orgId: org.id, status: "no_tenkara_org" };

  let row: SettingsRow | null;
  // Requirements moved off user_supplier_settings into their own tables, so this
  // is a second read against Tenkara. It shares the settings read's catch: a
  // failure here has to record sync_error too, or the mirror goes quietly stale
  // on half its content.
  let requirementRows: RequirementsRow[] = [];
  try {
    row = await fetchTenkaraSettings(org.tenkara_org_id);
    if (row) requirementRows = await fetchRequirementRows(org.tenkara_org_id);
  } catch (e: any) {
    // Record the failure rather than swallowing it: a silently dead sync is
    // exactly the failure mode this whole feature exists to fix.
    await admin
      .from("client_tenkara_settings")
      .update({ sync_error: e.message, updated_at: new Date().toISOString() })
      .eq("org_id", org.id);
    return { orgId: org.id, status: "error", error: e.message };
  }
  if (!row) return { orgId: org.id, status: "no_settings" };

  const addresses = (row.shipping_addresses ?? []).map(parseAddress).filter((a): a is ShipToAddress => a !== null);
  const primary = addresses[0] ?? null;

  // The two mirror columns keep their names and stay jsonb — nothing reads them,
  // they are here so the snapshot is inspectable — but what they hold is now the
  // normalized row rather than the old blob.
  const requirementBlob = (orderType: RequirementPhase) =>
    requirementRows.find((x) => x.order_type === orderType) ?? null;

  const { data: before } = await admin
    .from("client_tenkara_settings")
    .select("ship_to_address_line, ship_to_city, ship_to_zip, requirements_hash")
    .eq("org_id", org.id)
    .maybeSingle();

  const now = new Date().toISOString();
  const { error } = await admin.from("client_tenkara_settings").upsert(
    {
      org_id: org.id,
      ship_to_company: primary?.company ?? null,
      ship_to_address_line: primary?.addressLine ?? null,
      ship_to_apartment: primary?.apartment ?? null,
      ship_to_city: primary?.city ?? null,
      ship_to_state: primary?.state ?? null,
      ship_to_zip: primary?.zip ?? null,
      ship_to_country: primary?.country ?? null,
      shipping_addresses: addresses,
      billing_address: row.billing_address ?? null,
      samples_address: row.samples_address ?? null,
      unit_of_measurement: row.unit_of_measurement ?? null,
      federal_tax_id: row.federal_tax_id ?? null,
      excluded_material_countries: row.excluded_material_countries ?? [],
      excluded_packaging_countries: row.excluded_packaging_countries ?? [],
      pre_order_requirements: requirementBlob("pre_order"),
      post_order_requirements: requirementBlob("post_order"),
      source_updated_at: row.updated_at ?? null,
      synced_at: now,
      sync_error: null,
      updated_at: now,
    },
    { onConflict: "org_id" }
  );
  if (error) return { orgId: org.id, status: "error", error: error.message };

  const changed =
    (before?.ship_to_address_line ?? null) !== (primary?.addressLine ?? null) ||
    (before?.ship_to_city ?? null) !== (primary?.city ?? null) ||
    (before?.ship_to_zip ?? null) !== (primary?.zip ?? null);

  // Requirement drift is tracked separately from the ship-to diff above: it does
  // not change any address, it changes how every existing lead should be judged.
  // Best-effort — a failed fingerprint read reports "unknown", never "unchanged",
  // so a Tenkara hiccup can't be mistaken for the client clearing their specs.
  let requirementsHash: string | null = null;
  let requirementsChanged = false;
  try {
    requirementsHash = await requirementsFingerprint(org.tenkara_org_id);
    requirementsChanged = !!requirementsHash && requirementsHash !== (before?.requirements_hash ?? null);
  } catch {
    requirementsHash = null;
  }

  return { orgId: org.id, status: "synced", shipTo: shipToRegion(primary), changed, requirementsChanged, requirementsHash };
}

export interface SyncSummary {
  considered: number;
  synced: number;
  changed: number;
  missing: number;
  errored: number;
  changedOrgs: string[];
  // Orgs whose requirements moved, for the caller to re-check. Carries the new
  // fingerprint so the caller can record it only after a complete pass.
  requirementsChangedOrgs: { orgId: string; hash: string }[];
}

// Sync every linked org. Cheap enough (one small query per org) to run on every
// Agent 12 cycle, so ops never has to ask for a refresh.
export async function syncAllClientSettings(admin: SupabaseClient): Promise<SyncSummary> {
  const { data: orgs } = await admin.from("orgs").select("id, name, tenkara_org_id").not("tenkara_org_id", "is", null);

  const summary: SyncSummary = { considered: orgs?.length ?? 0, synced: 0, changed: 0, missing: 0, errored: 0, changedOrgs: [], requirementsChangedOrgs: [] };
  for (const org of orgs ?? []) {
    const res = await syncClientSettingsForOrg(admin, org as any);
    if (res.status === "synced") {
      summary.synced++;
      if (res.changed) {
        summary.changed++;
        summary.changedOrgs.push((org as any).name ?? res.orgId);
      }
      if (res.requirementsChanged && res.requirementsHash) {
        summary.requirementsChangedOrgs.push({ orgId: res.orgId, hash: res.requirementsHash });
      }
    } else if (res.status === "error") summary.errored++;
    else summary.missing++;
  }
  return summary;
}

// The agent-facing view of a client's synced settings. Returns null when the
// client has no ship-to configured in Tenkara, which callers must treat as
// "defer" rather than inventing anything.
export interface ClientShipTo {
  region: string | null;
  full: string | null;
  // The individual fields, for callers that have to fill a checkout form rather
  // than print an address (PRICING-04).
  parts: { city: string | null; state: string | null; zip: string | null; country: string | null };
  addressCount: number;
  syncedAt: string | null;
}

export async function getClientShipTo(admin: SupabaseClient, orgId: string | null): Promise<ClientShipTo | null> {
  if (!orgId) return null;
  const { data } = await admin
    .from("client_tenkara_settings")
    .select("ship_to_company, ship_to_address_line, ship_to_apartment, ship_to_city, ship_to_state, ship_to_zip, ship_to_country, shipping_addresses, synced_at")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data) return null;

  const a: ShipToAddress = {
    company: data.ship_to_company,
    addressLine: data.ship_to_address_line,
    apartment: data.ship_to_apartment,
    city: data.ship_to_city,
    state: data.ship_to_state,
    zip: data.ship_to_zip,
    country: data.ship_to_country,
  };
  const region = shipToRegion(a);
  if (!region) return null;
  return {
    region,
    full: formatFullAddress(a),
    parts: { city: a.city ?? null, state: a.state ?? null, zip: a.zip ?? null, country: a.country ?? null },
    addressCount: Array.isArray(data.shipping_addresses) ? data.shipping_addresses.length : 0,
    syncedAt: data.synced_at ?? null,
  };
}
