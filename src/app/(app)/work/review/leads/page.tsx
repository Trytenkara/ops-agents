import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/table";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { LeadRichRow, LeadRichHeaders } from "@/components/lead-rich-row";
import { leadRichColSpan } from "@/lib/lead-market";
import { resolveMaterialGrades } from "@/lib/tenkara-names";
import { LeadsExportCsvButton } from "@/components/leads-export-csv-button";
import { LeadsFilterBar } from "@/components/leads-filter-bar";
import { PaginationBar } from "@/components/pagination-bar";
import { ListPageHeader, FilterChip, FilterRow } from "@/components/list-page-header";

export const dynamic = "force-dynamic";

// Cross-org list of `leads_in_flight` rows produced by Agent 03 (and any other
// lead-creating agent). Defaults to stage='raw' since that's the new-from-cron
// bucket; filter via ?stage=… to peek at enriched / ready_for_approval / terminal.
const STAGES = ["raw", "enriched", "ready_for_outreach", "ready_for_approval", "terminal"] as const;
type Stage = (typeof STAGES)[number];

const SOURCES = ["ai_discovery", "existing_db", "marketplace"] as const;
// Supplier channel (payload.site_type): non-marketplace (RFQ-only) vs the two
// marketplace flavors. Lets ops split the manufacturer-direct list from the
// marketplace/retail list when triaging a long scout batch.
const CHANNELS = [
  { value: "N", label: "Non-marketplace" },
  { value: "MS", label: "Marketplace (signup)" },
  { value: "M", label: "Marketplace/retail" },
] as const;
const SORTS = [
  { value: "confidence", label: "Confidence" },
  { value: "completeness", label: "Ready to RFQ" },
] as const;
const PAGE_SIZE = 50;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: {
    stage?: string;
    drift?: string;
    material?: string;
    source?: string;
    status?: string;
    org?: string;
    channel?: string;
    sort?: string;
    priced?: string;
    page?: string;
  };
}) {
  const session = (await getSession())!;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) redirect("/work");

  const stage: Stage = (STAGES as readonly string[]).includes(searchParams.stage ?? "")
    ? (searchParams.stage as Stage)
    : "raw";
  const driftOnly = searchParams.drift === "1";
  const material = (searchParams.material ?? "").trim();
  const source = (searchParams.source ?? "").trim();
  const statusFilter = (searchParams.status ?? "").trim();
  const orgSlug = (searchParams.org ?? "").trim();
  const channel = (CHANNELS as readonly { value: string }[]).some((c) => c.value === searchParams.channel)
    ? (searchParams.channel as string)
    : "";
  const sort = searchParams.sort === "completeness" ? "completeness" : "confidence";
  const pricedOnly = searchParams.priced === "1";
  const pageRaw = parseInt(searchParams.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const admin = createAdminClient();
  const assigned = await getAssignedOrgIds(session);

  // Org dropdown options: assigned orgs for scoped users, all orgs for global.
  let orgOptions: { id: string; slug: string; name: string }[] = [];
  if (assigned === null) {
    const { data } = await admin.from("orgs").select("id, slug, name").neq("hidden", true).order("name");
    orgOptions = (data ?? []) as any[];
  } else if (assigned.length > 0) {
    const { data } = await admin.from("orgs").select("id, slug, name").in("id", assigned).neq("hidden", true).order("name");
    orgOptions = (data ?? []) as any[];
  }
  const selectedOrg = orgSlug ? orgOptions.find((o) => o.slug === orgSlug) ?? null : null;

  function applyFilters(q: any): any {
    let out: any = q.eq("stage", stage);
    if (statusFilter) out = out.eq("status", statusFilter);
    else if (stage === "terminal") out = out.in("status", ["active", "dropped", "terminal"]);
    else out = out.eq("status", "active");
    if (selectedOrg) out = out.eq("org_id", selectedOrg.id);
    else if (assigned) out = out.in("org_id", assigned);
    if (driftOnly) out = out.eq("payload->>catalog_drift", "no_longer_listed");
    if (material) {
      const esc = material.replace(/[,()]/g, " ");
      out = out.or(`material_name.ilike.%${esc}%,payload->>inci_name.ilike.%${esc}%`);
    }
    if (source) out = out.eq("source", source);
    if (channel) out = out.eq("payload->>site_type", channel);
    if (pricedOnly) out = out.not("payload->>pack_sizes_pricing", "is", null);
    return out;
  }

  // Two queries: head:true count for the pagination footer, then the page slice.
  const countQuery = applyFilters(
    admin.from("leads_in_flight").select("id", { count: "exact", head: true })
  );
  const { count: totalCount } = await countQuery;
  const total = totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const fromIdx = (safePage - 1) * PAGE_SIZE;
  const toIdx = fromIdx + PAGE_SIZE - 1;

  let listQuery = applyFilters(
    admin
      .from("leads_in_flight")
      .select(
        "id, org_id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, drop_reason, confidence_score, agent_run_id, created_at, updated_at, orgs(slug, name)"
      )
  );
  if (sort === "completeness") {
    // completeness_score lives in payload (no top-level column); JSON-path
    // order sorts these consistently since values are all 0.xx or 1.
    listQuery = listQuery.order("payload->>completeness_score", { ascending: false, nullsFirst: false });
  }
  listQuery = listQuery
    .order("confidence_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(fromIdx, toIdx);
  const { data: rows } = await listQuery;

  const canAct = seesAllOrgs(session) || (assigned !== null && assigned.length > 0);
  const rowCount = rows?.length ?? 0;

  // Grade lives on the Tenkara material — resolve by material_id and attach.
  let leadGrades = new Map<string, string>();
  try {
    leadGrades = await resolveMaterialGrades((rows ?? []).map((r: any) => r.material_id).filter(Boolean));
  } catch {
    // Tenkara unreachable — fall back to payload grade in the row component.
  }
  const leadRows = (rows ?? []).map((r: any) => ({
    ...r,
    grade: r.material_id ? leadGrades.get(r.material_id) ?? null : null,
  }));

  const baseFilters = {
    stage,
    ...(driftOnly ? { drift: "1" } : {}),
    ...(material ? { material } : {}),
    ...(source ? { source } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(orgSlug ? { org: orgSlug } : {}),
    ...(channel ? { channel } : {}),
    ...(sort !== "confidence" ? { sort } : {}),
    ...(pricedOnly ? { priced: "1" } : {}),
  };
  const baseQs = new URLSearchParams(baseFilters as Record<string, string>).toString();

  return (
    <div className="space-y-4">
      <ListPageHeader
        title="Leads in flight"
        description="Candidate suppliers staged by Agent 03 (Lead Creator) and other lead agents. Top of the list = highest confidence."
        actions={<LeadsExportCsvButton disabled={total === 0} count={total} filters={baseFilters} />}
        explainer={
          <>
            <span className="font-medium text-foreground">Agent-written rows, human-gated flow.</span>{" "}
            Rows are created by Agent 03 (Lead Creator) and processed by Agent 06 (Enrichment).
            Use <span className="font-medium text-foreground">Promote</span> to hand a lead to Agent 04 (Outreach) — moves it to <code>ready_for_outreach</code>.
            Use <span className="font-medium text-foreground">Drop</span> when a lead shouldn&apos;t be pursued — moves it to <code>terminal</code> with the reason recorded.
            Promotable from <code>enriched</code>, or from <code>raw</code> when enrichment was blocked but you want to contact anyway.
          </>
        }
        filters={
          <>
            <LeadsFilterBar orgs={orgOptions} selectedOrgId={orgSlug} material={material} />

            <FilterRow label="Stage:">
              {STAGES.map((s) => (
                <FilterChip key={s} href={buildHref({ ...baseFilters, stage: s })} active={s === stage}>
                  {s}
                </FilterChip>
              ))}
            </FilterRow>

            <FilterRow label="Source:">
              <FilterChip href={buildHref({ ...baseFilters, source: undefined })} active={!source}>
                all
              </FilterChip>
              {SOURCES.map((s) => (
                <FilterChip key={s} href={buildHref({ ...baseFilters, source: s })} active={s === source}>
                  {s}
                </FilterChip>
              ))}
              <FilterChip
                href={buildHref({ ...baseFilters, drift: driftOnly ? undefined : "1" })}
                active={driftOnly}
                tone="amber"
                title="Show only leads where Agent 05 flagged the catalog drift (supplier dropped material)."
              >
                {driftOnly ? "✓ catalog drift" : "+ catalog drift"}
              </FilterChip>
            </FilterRow>

            <FilterRow label="Channel:">
              <FilterChip href={buildHref({ ...baseFilters, channel: undefined })} active={!channel}>
                all
              </FilterChip>
              {CHANNELS.map((c) => (
                <FilterChip key={c.value} href={buildHref({ ...baseFilters, channel: c.value })} active={c.value === channel}>
                  {c.label}
                </FilterChip>
              ))}
              <FilterChip
                href={buildHref({ ...baseFilters, priced: pricedOnly ? undefined : "1" })}
                active={pricedOnly}
                tone="amber"
                title="Show only leads where the scanner captured published pack sizes / pricing."
              >
                {pricedOnly ? "✓ has pricing" : "+ has pricing"}
              </FilterChip>
            </FilterRow>

            <FilterRow label="Sort:">
              {SORTS.map((s) => (
                <FilterChip key={s.value} href={buildHref({ ...baseFilters, sort: s.value })} active={s.value === sort}>
                  {s.label}
                </FilterChip>
              ))}
            </FilterRow>
          </>
        }
      />

      <Table>
        <TableHeader>
          <LeadRichHeaders />
        </TableHeader>
        <TableBody>
          {leadRows.map((r: any) => (
            <LeadRichRow key={r.id} r={r} canAct={canAct} />
          ))}
          {rowCount === 0 && (
            <TableRow>
              <TableCell colSpan={leadRichColSpan()} className="text-center text-muted-foreground py-8">
                No leads match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <PaginationBar
        basePath="/work/review/leads"
        baseQs={baseQs}
        page={safePage}
        pageSize={PAGE_SIZE}
        total={total}
      />
    </div>
  );
}

function buildHref(p: {
  stage?: string;
  drift?: string;
  material?: string;
  source?: string;
  status?: string;
  org?: string;
  channel?: string;
  sort?: string;
  priced?: string;
}) {
  const sp = new URLSearchParams();
  if (p.stage) sp.set("stage", p.stage);
  if (p.drift) sp.set("drift", p.drift);
  if (p.material) sp.set("material", p.material);
  if (p.source) sp.set("source", p.source);
  if (p.status) sp.set("status", p.status);
  if (p.org) sp.set("org", p.org);
  if (p.channel) sp.set("channel", p.channel);
  if (p.sort && p.sort !== "confidence") sp.set("sort", p.sort);
  if (p.priced) sp.set("priced", p.priced);
  return `/work/review/leads?${sp.toString()}`;
}
