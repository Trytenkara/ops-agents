import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/auth";
import { orgDisplayName } from "@/lib/org-display";
import { correctMaterialSpelling } from "@/lib/material-spelling";
import { getClientRequirements, type RequirementItem } from "@/lib/tenkara-requirements";
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
    .select("id, slug, name, display_name, tenkara_org_id")
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

  // Client qualification requirements, read from Tenkara (Client Settings →
  // Sourcing Rules). Best-effort — a Tenkara hiccup just hides the checklist.
  let requirements: RequirementItem[] = [];
  try {
    requirements = await getClientRequirements(org.tenkara_org_id);
  } catch {
    requirements = [];
  }

  // Documents suppliers have actually sent back, captured from reply
  // attachments. Counted per type so The bench can mark a requirement received.
  const { data: docs } = await admin.from("supplier_documents").select("doc_type").eq("org_id", org.id);
  const docCountByType = new Map<string, number>();
  for (const d of (docs ?? []) as any[]) docCountByType.set(d.doc_type, (docCountByType.get(d.doc_type) ?? 0) + 1);
  // Requirement key → the document type that satisfies it. Sample is physical
  // (no document), so it has no mapping.
  const REQ_KEY_TO_DOCTYPE: Record<string, string> = {
    coa: "coa",
    sds: "sds",
    tds: "tds",
    certifications: "certificate",
    custom_statements: "statement",
    custom_testing: "testing",
    custom_documentation: "other",
  };
  const receivedFor = (key: string): number => docCountByType.get(REQ_KEY_TO_DOCTYPE[key] ?? "") ?? 0;

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

      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-serif text-lg tracking-tight">The bench</h3>
          <span className="text-xs text-muted-foreground">
            {requirements.length} qualification requirement{requirements.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          What this client requires to qualify a vendor, from their Tenkara sourcing rules. Items marked{" "}
          <span className="font-medium text-foreground">Requested</span> are added to the supplier follow-up email so we
          retrieve them; <span className="font-medium text-foreground">Dealbreaker</span> items block qualification if missing.
        </p>
        {requirements.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No qualification requirements configured for this client in Tenkara (Client Settings → Sourcing Rules).
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {requirements.map((r, i) => (
              <li key={`${r.phase}-${r.key}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <span className="text-sm">{r.label}</span>
                  {r.detail && r.kind !== "sample" && <span className="ml-2 text-xs text-muted-foreground">({r.detail})</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {r.phase === "pre_order" ? "Pre-order" : "Post-order"}
                  </span>
                  {r.requested && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                      Requested
                    </span>
                  )}
                  {r.dealbreaker && (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive">
                      Dealbreaker
                    </span>
                  )}
                  {r.kind !== "sample" && r.kind !== "spec" && receivedFor(r.key) > 0 && (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-600">
                      {receivedFor(r.key)} received
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Received counts come from documents suppliers attached to their replies, classified by file type. Parsing values
          out of each document (e.g. CoA assay/expiry) is the next step.
        </p>
      </section>
    </div>
  );
}
