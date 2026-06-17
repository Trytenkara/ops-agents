import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { ListPageHeader } from "@/components/list-page-header";
import { loadPricingThreads } from "@/lib/pricing-pipeline";
import { PricingPipelineTable } from "@/components/pricing-pipeline-table";

export const dynamic = "force-dynamic";

export default async function PricingPipelinePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const admin = createAdminClient();
  let orgIds: string[] | null = null;
  let emptyReason: string | undefined;
  if (!seesAllOrgs(session)) {
    orgIds = (await getAssignedOrgIds(session)) ?? [];
    if (orgIds.length === 0) emptyReason = "No orgs assigned to you yet.";
  }

  const data = orgIds && orgIds.length === 0 ? { threads: [], counts: {} } : await loadPricingThreads(admin, orgIds);

  return (
    <div className="space-y-6">
      <ListPageHeader title="Pricing Pipeline" description="Every supplier thread, from outreach to a finalized price." />
      <PricingPipelineTable data={data} emptyReason={emptyReason} />
    </div>
  );
}
