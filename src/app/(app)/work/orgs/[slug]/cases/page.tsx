import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { ListPageHeader } from "@/components/list-page-header";
import { CasesSection } from "@/components/cases-section";
import { loadOrgCases } from "@/lib/org-cases";

export const dynamic = "force-dynamic";

// Combined all-escalations fallback. Not in the org sub-nav anymore — each
// category now lives in its home tab (email → Email Thread Tracker, supplier →
// Agent Supplier Leads, quote → Agent Quotes). This page stays reachable from
// the Overview "Open cases" metric and shows every open case in one place.
export default async function CasesPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  // Calls are excluded: they carry a full phone brief that does not fit a table
  // row, and they have their own tab.
  const { openRows: open, resolvedRows: resolved, resolvedTotal } = await loadOrgCases(admin, org.id, undefined, [
    "email",
    "supplier",
    "quote",
  ]);

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Escalations"
        description="Every open escalation for this client in one place. These also appear in their home tab: email escalations in Email Thread Tracker, supplier escalations under Agent Supplier Leads, and quote escalations under Agent Quotes. Calls live on their own Call Tracker tab."
        collectedBy="Agents 05 + 07 + 15"
      />
      <CasesSection openRows={open} resolvedRows={resolved} resolvedTotal={resolvedTotal} slug={params.slug} emptyLabel="No open escalations." />
    </div>
  );
}
