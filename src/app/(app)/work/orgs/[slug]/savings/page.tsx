import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { redirect } from "next/navigation";
import { buildSavingsReport } from "@/lib/savings-report";
import { buildSourcingScorecard } from "@/lib/sourcing-scorecard";
import { loadMaterialAttributes } from "@/lib/material-attributes";
import { SavingsReportInteractive } from "@/components/savings-report-interactive";
import { SavingsWorksheet } from "@/components/savings-worksheet";
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
  const reportType = searchParams?.type === "freight" ? "freight" : "savings";
  const canEdit = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, tenkara_org_id")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();

  if (!org.tenkara_org_id) {
    return (
      <p className="text-sm text-muted-foreground">
        This client isn&apos;t linked to a Tenkara organization yet, so there are no quotes to compare. An admin can
        link it in the client&apos;s settings to enable savings.
      </p>
    );
  }

  const report = await buildSavingsReport(org.tenkara_org_id);
  const scorecard = await buildSourcingScorecard(admin, org.id, org.tenkara_org_id);

  if (view === "report") {
    // Loaded for both types: the "freight" view shows the detail editor, and the
    // "savings" view uses freight to optionally compute landed-cost savings.
    const attributes = await loadMaterialAttributes(org.id);
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
        <SavingsReportInteractive
          report={report}
          clientName={org.name}
          slug={org.slug}
          variant={reportType}
          attributes={attributes}
          orgId={org.id}
          canEdit={canEdit}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ViewToggle slug={org.slug} view={view} />
      <SavingsWorksheet report={report} scorecard={scorecard} slug={org.slug} clientName={org.name} />
    </div>
  );
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

function ReportTypeToggle({ slug, type }: { slug: string; type: "savings" | "freight" }) {
  const base = `/work/orgs/${slug}/savings?view=report`;
  const tab = (key: "savings" | "freight", label: string, href: string) => (
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
      {tab("savings", "Cost savings", base)}
      {tab("freight", "Freight & suppliers", `${base}&type=freight`)}
    </div>
  );
}
