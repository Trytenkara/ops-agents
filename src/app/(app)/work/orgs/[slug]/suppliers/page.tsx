import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import { ListPageHeader } from "@/components/list-page-header";
import { ClientSuppliersSection } from "@/components/client-suppliers-section";
import { getClientSuppliers } from "@/lib/client-suppliers";

export const dynamic = "force-dynamic";

export default async function OrgSuppliersPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const suppliers = await getClientSuppliers(org.tenkara_org_id ?? null);

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Suppliers"
        description={`Suppliers linked to ${org.name} in Tenkara, by approval status.`}
      />
      <ClientSuppliersSection suppliers={suppliers} slug={org.slug} />
    </div>
  );
}
