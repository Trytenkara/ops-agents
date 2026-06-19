import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadPricingThreads } from "@/lib/pricing-pipeline";
import { PricingPipelineTable } from "@/components/pricing-pipeline-table";

export const dynamic = "force-dynamic";

export default async function OrgPipelinePage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const data = await loadPricingThreads(admin, [org.id]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Every supplier thread for {org.name}, from outreach to a finalized price. Threads marked{" "}
        <span className="text-foreground font-medium">Stale</span> need an ops nudge.
      </p>
      <PricingPipelineTable data={data} emptyReason="No tracked threads yet. They appear here once outreach is staged for this client." slug={params.slug} />
    </div>
  );
}
