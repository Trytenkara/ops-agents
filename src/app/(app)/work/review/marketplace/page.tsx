import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { MarketplaceFindingRow, MarketplaceFindingHeaders, marketplaceFindingColSpan } from "@/components/marketplace-finding-row";
import { ExportApprovedCsvButton } from "@/components/marketplace-export-csv-button";
import { ListPageHeader } from "@/components/list-page-header";
import { correctMaterialSpelling } from "@/lib/material-spelling";

export const dynamic = "force-dynamic";

const STATUSES = ["pending_review", "approved", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

interface FindingRow {
  id: string;
  org_id: string | null;
  supplier_id: string;
  supplier_name: string;
  material_id: string;
  material_name: string;
  baseline_price: number | null;
  current_price: number | null;
  currency: string | null;
  pack_size: string | null;
  pct_change: number | null;
  classification: string;
  source_url: string | null;
  source_citations: string[] | null;
  notes: string | null;
  status: Status;
  approved_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  orgs: { slug: string; name: string } | null;
}

export default async function MarketplaceFindingsPage({
  searchParams,
}: {
  searchParams: { status?: string; supplier?: string; org?: string };
}) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const status: Status = (STATUSES as readonly string[]).includes(searchParams.status ?? "")
    ? (searchParams.status as Status)
    : "pending_review";
  const supplierFilter = (searchParams.supplier ?? "").trim();
  const orgFilter = (searchParams.org ?? "").trim();

  const assigned = await getAssignedOrgIds(session);
  const admin = createAdminClient();
  let q = admin
    .from("marketplace_check_findings")
    .select(
      "id, org_id, supplier_id, supplier_name, material_id, material_name, baseline_price, current_price, currency, pack_size, pct_change, classification, source_url, source_citations, notes, status, approved_at, dismissed_at, created_at, orgs(slug, name)"
    )
    .eq("status", status)
    .order("pct_change", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500);
  if (assigned) q = q.in("org_id", assigned);
  if (supplierFilter) q = q.ilike("supplier_name", `%${supplierFilter}%`);
  if (orgFilter) q = q.eq("org_id", orgFilter);

  const { data: rows, error } = await q;
  const findings = ((rows ?? []) as unknown as FindingRow[]).map((r) => ({
    ...r,
    material_name: correctMaterialSpelling(r.material_name),
  }));

  // Org chips: distinct orgs in the current result set.
  const orgsSeen = new Map<string, string>();
  for (const r of findings) {
    if (r.org_id && r.orgs?.name) orgsSeen.set(r.org_id, r.orgs.name);
  }

  // Suppliers seen for filter chips.
  const suppliersSeen = Array.from(new Set(findings.map((r) => r.supplier_name))).slice(0, 8);

  const canAct = seesAllOrgs(session) || (assigned !== null && assigned.length > 0);

  // Approved counts (across all orgs the user can see) for the export button.
  let approvedCountQ = admin
    .from("marketplace_check_findings")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved");
  if (assigned) approvedCountQ = approvedCountQ.in("org_id", assigned);
  const { count: approvedCount } = await approvedCountQ;

  return (
    <div className="space-y-4">
      <ListPageHeader
        title="Marketplace findings"
        description="Daily price re-check on Tenkara marketplace quotes expiring within 7 days. Highest % change first. Approve to queue for the next CSV export; ops uploads that CSV to Tenkara manually."
        actions={<ExportApprovedCsvButton disabled={!approvedCount} count={approvedCount ?? 0} />}
        explainer={
          <>
            <span className="font-medium text-foreground">Agent 05 (Marketplace Price Re-check)</span> writes one row per marketplace quote it re-checked.
            <span className="font-medium text-foreground"> Approve</span> queues a finding for the next CSV download.
            <span className="font-medium text-foreground"> Dismiss</span> marks it as noise / false-positive.
            Findings never write back to Tenkara automatically — your safety floor.
          </>
        }
        filters={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {STATUSES.map((s) => (
          <Link
            key={s}
            href={{ pathname: "/work/review/marketplace", query: { status: s, ...(supplierFilter ? { supplier: supplierFilter } : {}), ...(orgFilter ? { org: orgFilter } : {}) } }}
            className={
              "rounded-full px-3 py-1 border " +
              (s === status
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {s.replace("_", " ")}
          </Link>
        ))}
        {orgsSeen.size > 0 && <span className="text-xs text-muted-foreground ml-2">orgs:</span>}
        {Array.from(orgsSeen.entries()).map(([id, name]) => (
          <Link
            key={id}
            href={{ pathname: "/work/review/marketplace", query: { status, ...(orgFilter === id ? {} : { org: id }) } }}
            className={
              "rounded-full px-2 py-0.5 text-xs border " +
              (orgFilter === id
                ? "bg-secondary border-secondary text-secondary-foreground"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {orgFilter === id ? "✓ " : ""}
            {name}
          </Link>
        ))}
        {suppliersSeen.length > 1 && <span className="text-xs text-muted-foreground ml-2">suppliers:</span>}
        {suppliersSeen.map((sn) => (
          <Link
            key={sn}
            href={{ pathname: "/work/review/marketplace", query: { status, ...(supplierFilter === sn ? {} : { supplier: sn }) } }}
            className={
              "rounded-full px-2 py-0.5 text-xs border " +
              (supplierFilter === sn
                ? "bg-secondary border-secondary text-secondary-foreground"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {supplierFilter === sn ? "✓ " : ""}
            {sn}
          </Link>
        ))}
          </div>
        }
      />

      <Table>
        <TableHeader>
          <MarketplaceFindingHeaders />
        </TableHeader>
        <TableBody>
          {findings.length === 0 && (
            <TableRow>
              <TableCell colSpan={marketplaceFindingColSpan()} className="text-center text-muted-foreground py-10">
                {error ? (
                  <span className="text-destructive">Query failed: {error.message}</span>
                ) : status === "pending_review" ? (
                  <>
                    <div className="font-medium text-foreground mb-1">No findings yet.</div>
                    Agent 05 will populate this once it&apos;s wired in. Until then, this page stays empty by design.
                  </>
                ) : (
                  <>No {status.replace("_", " ")} findings.</>
                )}
              </TableCell>
            </TableRow>
          )}
          {findings.map((r) => (
            <MarketplaceFindingRow key={r.id} r={r} canAct={canAct} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
