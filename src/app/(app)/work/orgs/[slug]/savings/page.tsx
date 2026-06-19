import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { redirect } from "next/navigation";
import { buildSavingsReport } from "@/lib/savings-report";
import { buildSourcingScorecard } from "@/lib/sourcing-scorecard";
import { SavingsReportInteractive } from "@/components/savings-report-interactive";
import { SavingsWorksheet } from "@/components/savings-worksheet";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function OrgSavingsPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { view?: string };
}) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");
  const view = searchParams?.view === "report" ? "report" : "table";

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
        This org isn&apos;t linked to a Tenkara organization yet, so there are no quotes to compare. Set{" "}
        <code className="text-xs">tenkara_org_id</code> on the org to enable savings.
      </p>
    );
  }

  const report = await buildSavingsReport(org.tenkara_org_id);
  const scorecard = await buildSourcingScorecard(admin, org.id, org.tenkara_org_id);

  if (view === "report") {
    return (
      <div className="space-y-6">
        <ViewToggle slug={org.slug} view={view} />
        <SavingsReportInteractive report={report} clientName={org.name} slug={org.slug} />
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
        view === key ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
    </Link>
  );
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-1 print:hidden">
      {tab("table", "Worksheet", base)}
      {tab("report", "Savings report", `${base}?view=report`)}
    </div>
  );
}
