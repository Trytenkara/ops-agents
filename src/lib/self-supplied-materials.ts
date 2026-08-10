import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Materials the client supplies themselves. The client owns this switch on the
// Tenkara material form (both "add material" and the material settings page
// write materials.self_supplied), and it means "we already have this, don't
// source it": no discovery, no enrichment, no new outreach, no price pull.
//
// Lookup failure resolves to an empty set so a Tenkara outage degrades to
// today's behaviour instead of stalling the fleet.
export async function loadSelfSuppliedMaterialIds(): Promise<Set<string>> {
  const rows = await tenkaraQuery<{ id: string }>(
    `select id::text as id from public.materials where self_supplied is true`
  );
  return new Set(rows.map((r) => r.id));
}
