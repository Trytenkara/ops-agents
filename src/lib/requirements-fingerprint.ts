// A stable fingerprint of everything a client can change that should force their
// existing leads to be judged again: the qualification requirements, the country
// exclusions, the do-not-contact list, and every material's grade spec (which is
// where dealbreaker grades live).
//
// Existing leads froze their verdict at enrichment time, so without this a client
// who adds a dealbreaker grade, or adds a material, only gets it applied to leads
// discovered after the edit. Comparing this hash against the last one we acted on
// tells Agent 12 which orgs actually moved, so an hourly pass costs one small
// query per org instead of a full re-check of the fleet.

import { createHash } from "node:crypto";
import { tenkaraQuery } from "./tenkara-readonly";

interface SettingsRow {
  pre_order_requirements: any;
  post_order_requirements: any;
  excluded_material_countries: string[] | null;
  excluded_packaging_countries: string[] | null;
  dnc_suppliers: any;
}

interface MaterialGradeRow {
  id: string;
  grade: string | null;
}

// Throws on a Tenkara read failure rather than returning a "nothing configured"
// hash: a hash built from a failed read would look like the client deleted every
// requirement, and would trigger a fleet-wide re-check that clears real verdicts.
export async function requirementsFingerprint(orgTenkaraId: string | null | undefined): Promise<string | null> {
  if (!orgTenkaraId) return null;

  const settings = await tenkaraQuery<SettingsRow>(
    `select pre_order_requirements, post_order_requirements,
            excluded_material_countries, excluded_packaging_countries, dnc_suppliers
       from public.user_supplier_settings
      where organization_id = $1::uuid
      limit 1`,
    [orgTenkaraId]
  );

  // jsonb renders with normalized (sorted) keys, so the text form is stable
  // across reads and safe to hash directly.
  const materials = await tenkaraQuery<MaterialGradeRow>(
    `select m.id::text as id, coalesce(m.grade::text, '') as grade
       from public.materials m
       join public.users u on u.id = m.user_id
      where u.organization_id = $1::uuid
      order by m.id`,
    [orgTenkaraId]
  );

  const s = settings[0];
  const canonical = JSON.stringify({
    pre: s?.pre_order_requirements ?? null,
    post: s?.post_order_requirements ?? null,
    materialCountries: (s?.excluded_material_countries ?? []).slice().sort(),
    packagingCountries: (s?.excluded_packaging_countries ?? []).slice().sort(),
    dnc: s?.dnc_suppliers ?? null,
    materials: materials.map((m) => [m.id, m.grade]),
  });

  return createHash("sha256").update(canonical).digest("hex");
}
