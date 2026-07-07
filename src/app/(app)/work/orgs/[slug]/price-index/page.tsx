import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { orgDisplayName } from "@/lib/org-display";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { resolveSupplierNamesWithFallback, resolveMaterialNames, resolveQuoteRefs, resolveQuoteExpiries } from "@/lib/tenkara-names";
import { ListPageHeader } from "@/components/list-page-header";
import { MarketplaceFindingsList } from "@/components/marketplace-findings-list";
import { RequoteList, type RequoteRow } from "@/components/requote-list";
import { PriceIndexTabs } from "@/components/price-index-tabs";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUSES = [
  { value: "pending_review", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "dismissed", label: "Dismissed" },
] as const;
type Status = (typeof STATUSES)[number]["value"];

// Price Index — one place to keep a client's pricing current across suppliers.
// Marketplace suppliers: re-check the current public price (Agent 05). Direct
// suppliers: there's no public price, so an expiring quote becomes a re-quote
// draft (Agent 02). Folds in the old Price Changes tab.
export default async function OrgPriceIndexPage({
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
  const { data: org } = await admin.from("orgs").select("id, slug, name, display_name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const [findingsRes, draftsRes] = await Promise.all([
    admin
      .from("marketplace_check_findings")
      .select(
        "id, supplier_name, material_name, baseline_price, current_price, currency, pack_size, pct_change, classification, status, source_url, notes, created_at, orgs(slug, name)"
      )
      .eq("org_id", org.id)
      .eq("status", status)
      .order("pct_change", { ascending: false, nullsFirst: false })
      .limit(200),
    admin
      .from("draft_references")
      .select(
        "id, subject, supplier_id, material_id, quote_id, status, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), reviewer:users!draft_references_reviewer_fkey(display_name), agents(slug)"
      )
      .eq("org_id", org.id)
      .eq("agents.slug", "agent-02-revalidation")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const findings = findingsRes.data ?? [];
  const draftRows = (draftsRes.data ?? []).filter((d: any) => d.agents?.slug === "agent-02-revalidation");

  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  // Resolve supplier/material/quote names for the direct re-quote drafts.
  let supplierNames = new Map<string, string>();
  let materialNames = new Map<string, string>();
  let quoteRefs = new Map<string, string>();
  let quoteExpiries = new Map<string, string>();
  try {
    [supplierNames, materialNames, quoteRefs, quoteExpiries] = await Promise.all([
      resolveSupplierNamesWithFallback(draftRows.map((d: any) => d.supplier_id).filter(Boolean)),
      resolveMaterialNames(draftRows.map((d: any) => d.material_id).filter(Boolean)),
      resolveQuoteRefs(draftRows.map((d: any) => d.quote_id).filter(Boolean)),
      resolveQuoteExpiries(draftRows.map((d: any) => d.quote_id).filter(Boolean)),
    ]);
  } catch {
    // Tenkara unreachable — rows fall back to "name unavailable".
  }

  const requotes: RequoteRow[] = draftRows.map((d: any) => ({
    id: d.id,
    subject: d.subject ?? null,
    supplierId: d.supplier_id ?? null,
    supplierName: d.supplier_id ? supplierNames.get(d.supplier_id) ?? null : null,
    materialId: d.material_id ?? null,
    materialName: d.material_id ? materialNames.get(d.material_id) ?? null : null,
    quoteRef: d.quote_id ? quoteRefs.get(d.quote_id) ?? null : null,
    quoteExpiry: d.quote_id ? quoteExpiries.get(d.quote_id) ?? null : null,
    status: d.status,
    createdAt: d.created_at ?? null,
    metadata: d.metadata,
    assignedName: d.users?.display_name ?? null,
    assignedEmail: d.users?.email ?? null,
    assignedRole: primaryRole(operatorRoles(d.users)),
    reviewerName: d.reviewer?.display_name ?? null,
  }));

  const base = `/work/orgs/${org.slug}/price-index`;

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Live Price Index"
        description={`Keep ${orgDisplayName(org)}'s pricing current. Marketplace suppliers are re-checked against their public price; direct suppliers get a re-quote draft to send.`}
        collectedBy="Agent 05 (Marketplace Re-check) + Agent 02 (Revalidation)"
        actions={
          <Link
            href={`/work/orgs/${org.slug}/threads`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-primary hover:bg-secondary/60"
          >
            All conversations in Threads →
          </Link>
        }
        explainer={
          <>
            Marketplace prices are read from public pages — a <span className="font-medium text-foreground">needs manual login</span> flag
            means it&apos;s behind a sign-in wall. Direct suppliers have no public price, so we draft a re-quote email instead.
          </>
        }
      />

      <PriceIndexTabs
        marketplaceCount={findings.length}
        directCount={requotes.length}
        marketplace={
          <section className="space-y-3">
            <p className="text-sm text-muted-foreground">Current public price vs. what&apos;s on file. Approve the ones worth applying.</p>
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
              <p className="text-sm text-muted-foreground py-4">
                No {STATUSES.find((s) => s.value === status)?.label.toLowerCase()} marketplace re-checks.
              </p>
            ) : (
              <MarketplaceFindingsList rows={findings} canAct={canAct} slug={org.slug} />
            )}
          </section>
        }
        direct={
          <section className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Expiring quotes from non-marketplace suppliers, drafted for a fresh quote. Review and send — the full
              back-and-forth is logged in{" "}
              <Link href={`/work/orgs/${org.slug}/threads`} className="text-primary hover:underline">Threads</Link>.
            </p>
            {requotes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No re-quote drafts right now.</p>
            ) : (
              <RequoteList rows={requotes} slug={org.slug} />
            )}
          </section>
        }
      />
    </div>
  );
}
