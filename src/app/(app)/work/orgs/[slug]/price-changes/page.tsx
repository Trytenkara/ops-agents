import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { MarketplaceFindingsList } from "@/components/marketplace-findings-list";
import { ListPageHeader } from "@/components/list-page-header";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUSES = [
  { value: "pending_review", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "dismissed", label: "Dismissed" },
] as const;
type Status = (typeof STATUSES)[number]["value"];

export default async function OrgPriceChangesPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { status?: string };
}) {
  const session = (await getSession())!;
  const status: Status = STATUSES.some((s) => s.value === searchParams?.status)
    ? (searchParams!.status as Status)
    : "pending_review";

  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const { data: rows } = await admin
    .from("marketplace_check_findings")
    .select(
      "id, supplier_name, material_name, baseline_price, current_price, currency, pack_size, pct_change, classification, status, source_url, notes, created_at, orgs(slug, name)"
    )
    .eq("org_id", org.id)
    .eq("status", status)
    .order("pct_change", { ascending: false, nullsFirst: false })
    .limit(200);
  const findings = rows ?? [];
  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  const base = `/work/orgs/${org.slug}/price-changes`;

  return (
    <div className="space-y-4">
      <ListPageHeader
        level={2}
        title="Price Changes"
        description={`Current marketplace prices re-checked against what ${org.name} has on file. Approve the ones worth applying, then update Tenkara via bulk upload.`}
        explainer={
          <>
            Prices are read from public marketplace pages. A <span className="font-medium text-foreground">needs manual login</span> flag
            means the price sits behind a sign-in wall — sign up and pull it by hand.
          </>
        }
      />

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <Link
            key={s.value}
            href={s.value === "pending_review" ? base : `${base}?status=${s.value}`}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              status === s.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s.label}
          </Link>
        ))}
      </div>

      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No {STATUSES.find((s) => s.value === status)?.label.toLowerCase()} price changes.</p>
      ) : (
        <MarketplaceFindingsList rows={findings} canAct={canAct} slug={params.slug} />
      )}
    </div>
  );
}
