import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { redirect } from "next/navigation";
import { buildSavingsReport, clientCostFromOrders, clientOrderDetails } from "@/lib/savings-report";
import { buildSourcingScorecard } from "@/lib/sourcing-scorecard";
import { loadMaterialAttributes } from "@/lib/material-attributes";
import { SavingsReportInteractive } from "@/components/savings-report-interactive";
import { ExpeditedReportInteractive } from "@/components/expedited-report-interactive";
import { toExpeditedReport, type ExpeditedMeta } from "@/lib/expedited-report";
import { SavingsWorksheet } from "@/components/savings-worksheet";
import { orgDisplayName } from "@/lib/org-display";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function OrgSavingsPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { view?: string; type?: string };
}) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");
  const view = searchParams?.view === "report" ? "report" : "table";
  // "freight" (Quick Report) is the default and replaces the retired "Cost savings"
  // type — it renders the same savings cards plus freight/supplier detail.
  const reportType = searchParams?.type === "expedited" ? "expedited" : "freight";
  const canEdit = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, display_name, tenkara_org_id")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();
  const orgName = orgDisplayName(org);

  if (!org.tenkara_org_id) {
    return (
      <p className="text-sm text-muted-foreground">
        This client isn&apos;t linked to a Tenkara organization yet, so there are no quotes to compare. An admin can
        link it in the client&apos;s settings to enable savings.
      </p>
    );
  }

  // Client current cost from uploaded POs fills the baseline when Tenkara has no
  // current_quote, so savings show against a real client cost where we have one.
  const clientCostFallback = await clientCostFromOrders(admin, org.id).catch(() => new Map<string, number>());
  const report = await buildSavingsReport(org.tenkara_org_id, { clientCostFallback });
  const scorecard = await buildSourcingScorecard(admin, org.id, org.tenkara_org_id);

  if (view === "report") {
    // Quick Report ("freight") shows the freight/supplier detail editor and the
    // optional landed-cost toggle; both need the material attributes.
    const attributes = await loadMaterialAttributes(org.id);

    // The expedited report needs the market quotes attached + the PO-derived
    // curated layer; build both once here so meta and render share one report.
    const expedited =
      reportType === "expedited"
        ? await (async () => {
            const enriched = await buildSavingsReport(org.tenkara_org_id!, { clientCostFallback, includeQuotes: true });
            const meta = await buildExpeditedMeta(admin, org.id, enriched);
            return toExpeditedReport(enriched, {
              clientName: orgName,
              reportDate: new Date().toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" }),
              meta,
            });
          })()
        : null;

    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">View</div>
            <ViewToggle slug={org.slug} view={view} />
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Report type</div>
            <ReportTypeToggle slug={org.slug} type={reportType} />
          </div>
        </div>
        {expedited ? (
          <ExpeditedReportInteractive report={expedited} slug={org.slug} />
        ) : (
          <SavingsReportInteractive
            report={report}
            clientName={orgName}
            slug={org.slug}
            variant="freight"
            attributes={attributes}
            orgId={org.id}
            canEdit={canEdit}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ViewToggle slug={org.slug} view={view} />
      <SavingsWorksheet report={report} scorecard={scorecard} slug={org.slug} clientName={orgName} />
    </div>
  );
}

// Builds the curated layer for the expedited report from uploaded-PO data:
// incumbent supplier, typical order quantity, est spend, and the run-level
// baseline + identified-savings dollars. Materials without an order are omitted
// (they render "—"), and dollars only appear when at least one order carries qty.
async function buildExpeditedMeta(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  report: Awaited<ReturnType<typeof buildSavingsReport>>
): Promise<ExpeditedMeta> {
  const orders = await clientOrderDetails(admin, orgId).catch(() => new Map());
  const materials: NonNullable<ExpeditedMeta["materials"]> = {};
  let baselineSpend = 0;
  let identified = 0;
  let haveSpend = false;

  for (const l of report.lines) {
    const key = `${l.material_id}|${l.unit}`;
    const od = orders.get(key);
    if (!od) continue;
    const entry: NonNullable<ExpeditedMeta["materials"]>[string] = {};
    if (od.incumbent_name) entry.incumbent_name = od.incumbent_name;
    if (od.ordered_qty != null) {
      entry.typical_order = `${od.ordered_qty.toLocaleString()} ${l.unit}`;
      const spend = od.ordered_qty * l.their_unit_price;
      entry.est_spend = spend;
      baselineSpend += spend;
      haveSpend = true;
      if (l.savings_per_unit > 0) identified += od.ordered_qty * l.savings_per_unit;
    }
    materials[key] = entry;
  }

  return {
    materials,
    ...(haveSpend ? { baseline_spend: baselineSpend, identified_savings: identified } : {}),
  };
}

function ViewToggle({ slug, view }: { slug: string; view: "table" | "report" }) {
  const base = `/work/orgs/${slug}/savings`;
  const tab = (key: "table" | "report", label: string, href: string) => (
    <Link
      href={href}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        view === key ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </Link>
  );
  return (
    <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-1 print:hidden">
      {tab("table", "Worksheet", base)}
      {tab("report", "Savings report", `${base}?view=report`)}
    </div>
  );
}

function ReportTypeToggle({ slug, type }: { slug: string; type: "freight" | "expedited" }) {
  const base = `/work/orgs/${slug}/savings?view=report`;
  const tab = (key: "freight" | "expedited", label: string, href: string) => (
    <Link
      href={href}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        type === key ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </Link>
  );
  return (
    <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-1 print:hidden">
      {tab("freight", "Quick Report", base)}
      {tab("expedited", "Detailed Report", `${base}&type=expedited`)}
    </div>
  );
}
