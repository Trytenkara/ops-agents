import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { getMaterialProfile } from "@/lib/material-profile";
import { MaterialsPanel } from "@/components/materials-panel";

export const dynamic = "force-dynamic";

export default async function OrgMaterialsPage({ params }: { params: { slug: string } }) {
  const session = await getSession();
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const profile = await getMaterialProfile(org.id);
  const canEdit = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);

  return <MaterialsPanel orgId={org.id} profile={profile} canEdit={canEdit} />;
}
