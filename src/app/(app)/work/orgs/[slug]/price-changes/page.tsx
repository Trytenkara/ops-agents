import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { MarketplaceFindingsList } from "@/components/marketplace-findings-list";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";

export const dynamic = "force-dynamic";

export default async function OrgPriceChangesPage({ params }: { params: { slug: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: rows } = await admin
    .from("marketplace_check_findings")
    .select(
      "id, supplier_name, material_name, baseline_price, current_price, currency, pack_size, pct_change, classification, status, source_url, notes, created_at, orgs(slug, name)"
    )
    .eq("org_id", org.id)
    .eq("status", "pending_review")
    .order("pct_change", { ascending: false, nullsFirst: false })
    .limit(200);
  const findings = rows ?? [];
  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Marketplace price changes Agent 05 flagged for {org.name}. Approve the ones worth applying, then update the Tenkara platform manually.
      </p>
      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No price changes pending review.</p>
      ) : (
        <MarketplaceFindingsList rows={findings} canAct={canAct} slug={params.slug} />
      )}
    </div>
  );
}
