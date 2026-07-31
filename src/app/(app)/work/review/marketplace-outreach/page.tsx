import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { ListPageHeader } from "@/components/list-page-header";
import { MarketplaceOutreachRow } from "@/components/marketplace-outreach-row";

export const dynamic = "force-dynamic";

export default async function MarketplaceOutreachReviewPage() {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");
  const assigned = await getAssignedOrgIds(session);
  const admin = createAdminClient();
  let query = admin
    .from("leads_in_flight")
    .select("id, org_id, supplier_name, material_name, payload, confidence_score, created_at, orgs(name, slug)")
    .eq("status", "active")
    .eq("stage", "ready_for_approval")
    .eq("payload->marketplace_outreach_review->>pending", "true")
    .order("confidence_score", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(500);
  if (assigned) query = query.in("org_id", assigned);
  const { data: rows, error } = await query;
  const canAct = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) && (seesAllOrgs(session) || (assigned !== null && assigned.length > 0));

  return (
    <div className="space-y-4">
      <ListPageHeader
        title="Marketplace outreach review"
        description="Low-confidence marketplace leads stay here until an operator verifies a supplier-owned contact and explicitly approves outreach."
        explainer={<>Verified supplier-owned contact plus operator approval are required before Agent 04 can draft a first email.</>}
      />
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left"><tr><th className="px-3 py-2">Supplier</th><th className="px-3 py-2">Material</th><th className="px-3 py-2">Contact</th><th className="px-3 py-2">Trust signals</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Decision</th></tr></thead>
          <tbody>{(rows ?? []).map((row) => <MarketplaceOutreachRow key={row.id} row={row} canAct={canAct} />)}</tbody>
        </table>
      </div>
      {!rows?.length && !error && <p className="py-8 text-center text-sm text-muted-foreground">No marketplace leads are awaiting outreach approval.</p>}
    </div>
  );
}
