import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { getMaterialProfile } from "@/lib/material-profile";
import { getMaterialSourcingStatus } from "@/lib/material-sourcing-status";
import { MaterialsPanel } from "@/components/materials-panel";

export const dynamic = "force-dynamic";

export default async function OrgMaterialsPage({ params }: { params: { slug: string } }) {
  const session = await getSession();
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const profile = await getMaterialProfile(org.id);
  const statuses = await getMaterialSourcingStatus(admin, org.id, org.tenkara_org_id ?? null, profile);
  const canEdit = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);

  const { data: settingsRow } = await admin
    .from("client_settings")
    .select("sourcing_notes")
    .eq("org_id", org.id)
    .maybeSingle();

  // Collected quotes per material (Quotes tab folded in here): each carries its
  // own approval status (pending_review / approved / dismissed).
  const { data: quoteRows } = await admin
    .from("staged_quotes")
    .select("id, material_id, supplier_name, price, case_size, unit_of_measurement, unit_price, status, confidence, created_at")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(1000);
  const quotesByMaterial: Record<string, any[]> = {};
  for (const q of quoteRows ?? []) {
    if (!q.material_id) continue;
    (quotesByMaterial[q.material_id] ??= []).push(q);
  }

  return (
    <MaterialsPanel
      orgId={org.id}
      slug={org.slug}
      profile={profile}
      canEdit={canEdit}
      statuses={statuses}
      quotesByMaterial={quotesByMaterial}
      sourcingNotes={settingsRow?.sourcing_notes ?? null}
    />
  );
}
