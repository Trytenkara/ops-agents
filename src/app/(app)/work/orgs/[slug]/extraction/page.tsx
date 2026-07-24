import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/auth";
import { orgDisplayName } from "@/lib/org-display";
import { correctMaterialSpelling } from "@/lib/material-spelling";
import { ListPageHeader } from "@/components/list-page-header";
import { ExtractionQuoteBoard } from "@/components/extraction-quote-board";

export const dynamic = "force-dynamic";

// Platform Extraction — the per-client "live pool" the Tenkara platform draws
// from (pipeline-framing spec, Part 1). Surfaces everything the agents pulled
// out of supplier replies + attachments so Evan can pull it into Tenkara,
// grouped under the spec's platform-facing names. Read-only: Tenkara is never
// written from here.
export default async function OrgExtractionPage({ params }: { params: { slug: string } }) {
  await getSession();
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, display_name")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();

  const { data: staged } = await admin
    .from("staged_quotes")
    .select(
      "id, supplier_name, material_name, grade, price, case_size, unit_of_measurement, unit_price, currency, lead_time_days, lead_time_text, moq_quantity, moq_unit, payment_terms, source, source_attachment_name, confidence, status, created_at"
    )
    .eq("org_id", org.id)
    .neq("status", "dismissed")
    .order("created_at", { ascending: false })
    .limit(1000);

  const rows = (staged ?? []).map((r: any) => ({ ...r, material_name: correctMaterialSpelling(r.material_name) }));

  return (
    <div className="space-y-8">
      <ListPageHeader
        level={2}
        title="Platform Extraction"
        description={`The live pool of supplier info the agents have pulled for ${orgDisplayName(org)}. Grouped the way the platform frames it — copy any row to pull it into Tenkara.`}
        collectedBy="Agent 08 / 13 / 15 (reply + attachment extraction)"
        explainer={
          <>
            Everything here was extracted from supplier replies and price sheets — nothing is manually entered. Use{" "}
            <span className="font-medium text-foreground">Copy</span> on a row to grab a tab-separated line you can paste
            straight into a Tenkara quote.
          </>
        }
      />

      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-serif text-lg tracking-tight">Quote board</h3>
          <span className="text-xs text-muted-foreground">{rows.length} extracted line{rows.length === 1 ? "" : "s"}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Prices, grade, lead time, MOQ, and payment terms captured from what suppliers sent back.
        </p>
        <ExtractionQuoteBoard rows={rows} slug={org.slug} />
      </section>

      <section className="space-y-2">
        <div className="flex items-baseline gap-2">
          <h3 className="font-serif text-lg tracking-tight text-muted-foreground">The bench</h3>
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Pending extraction
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          SDS / CoA documents, certs on file, and compliance confirmations will surface here once document extraction ships.
          Today attachments are parsed for pricing only.
        </p>
      </section>
    </div>
  );
}
