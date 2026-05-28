import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { LeadRowActions } from "@/components/lead-row-actions";
import { LeadsExportCsvButton } from "@/components/leads-export-csv-button";
import { LeadsFilterBar } from "@/components/leads-filter-bar";
import { PaginationBar } from "@/components/pagination-bar";

export const dynamic = "force-dynamic";

// Cross-org list of `leads_in_flight` rows produced by Agent 03 (and any other
// lead-creating agent). Defaults to stage='raw' since that's the new-from-cron
// bucket; filter via ?stage=… to peek at enriched / ready_for_approval / terminal.
const STAGES = ["raw", "enriched", "ready_for_outreach", "ready_for_approval", "terminal"] as const;
type Stage = (typeof STAGES)[number];

const SOURCES = ["ai_discovery", "existing_db", "marketplace"] as const;
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
  const pageRaw = parseInt(searchParams.page ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const admin = createAdminClient();
  const assigned = await getAssignedOrgIds(session);

  // Org dropdown options: assigned orgs for scoped users, all orgs for global.
  let orgOptions: { id: string; slug: string; name: string }[] = [];
  if (assigned === null) {
    const { data } = await admin.from("orgs").select("id, slug, name").order("name");
    orgOptions = (data ?? []) as any[];
  } else if (assigned.length > 0) {
    const { data } = await admin.from("orgs").select("id, slug, name").in("id", assigned).order("name");
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

  const listQuery = applyFilters(
    admin
      .from("leads_in_flight")
      .select(
        "id, org_id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, drop_reason, confidence_score, agent_run_id, created_at, orgs(slug, name)"
      )
  )
    .order("confidence_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(fromIdx, toIdx);
  const { data: rows } = await listQuery;

  const canAct = seesAllOrgs(session) || (assigned !== null && assigned.length > 0);
  const rowCount = rows?.length ?? 0;

  const baseFilters = {
    stage,
    ...(driftOnly ? { drift: "1" } : {}),
    ...(material ? { material } : {}),
    ...(source ? { source } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(orgSlug ? { org: orgSlug } : {}),
  };
  const baseQs = new URLSearchParams(baseFilters as Record<string, string>).toString();

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl tracking-tight">Leads in flight</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Candidate suppliers staged by Agent 03 (Lead Creator) and other lead agents. Top of the list = highest confidence.
          </p>
        </div>
        <LeadsExportCsvButton
          disabled={total === 0}
          count={total}
          filters={baseFilters}
        />
      </div>

      <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Agent-written rows, human-gated flow.</span>{" "}
        Rows are created by Agent 03 (Lead Creator) and processed by Agent 06 (Enrichment).
        Use <span className="font-medium text-foreground">Promote</span> to hand a lead to Agent 04 (Outreach) — moves it to <code>ready_for_outreach</code>.
        Use <span className="font-medium text-foreground">Drop</span> when a lead shouldn&apos;t be pursued — moves it to <code>terminal</code> with the reason recorded.
        Promotable from <code>enriched</code>, or from <code>raw</code> when enrichment was blocked but you want to contact anyway.
      </div>

      <LeadsFilterBar orgs={orgOptions} selectedOrgId={orgSlug} material={material} />

      <div className="flex flex-wrap gap-2 text-sm">
        <span className="text-xs text-muted-foreground self-center mr-1">Stage:</span>
        {STAGES.map((s) => (
          <Link
            key={s}
            href={buildHref({ ...baseFilters, stage: s })}
            className={
              "rounded-full px-3 py-1 border " +
              (s === stage
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {s}
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <span className="text-xs text-muted-foreground self-center mr-1">Source:</span>
        <Link
          href={buildHref({ ...baseFilters, source: undefined })}
          className={
            "rounded-full px-3 py-1 border " +
            (!source
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:text-foreground")
          }
        >
          all
        </Link>
        {SOURCES.map((s) => (
          <Link
            key={s}
            href={buildHref({ ...baseFilters, source: s })}
            className={
              "rounded-full px-3 py-1 border " +
              (s === source
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground")
            }
          >
            {s}
          </Link>
        ))}
        <Link
          href={buildHref({ ...baseFilters, drift: driftOnly ? undefined : "1" })}
          className={
            "rounded-full px-3 py-1 border ml-auto " +
            (driftOnly
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40"
              : "border-border text-muted-foreground hover:text-foreground")
          }
          title="Show only leads where Agent 05 flagged the catalog drift (supplier dropped material)."
        >
          {driftOnly ? "✓ catalog drift" : "+ catalog drift"}
        </Link>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Supplier</TableHead>
            <TableHead>Material</TableHead>
            <TableHead>Signal</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Org</TableHead>
            <TableHead>Staged</TableHead>
            <TableHead>Run</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(rows ?? []).map((r: any) => {
            const signal = r.payload?.signal as string | undefined;
            const signalCount = r.payload?.signal_count as number | undefined;
            const conf = r.confidence_score != null ? Number(r.confidence_score) : null;
            const isScout = r.source === "ai_discovery";
            const sourceUrl = (r.payload?.source_url ?? r.payload?.supplier_website) as string | undefined;
            const siteType = r.payload?.site_type as "M" | "MS" | "N" | undefined;
            const citations = Array.isArray(r.payload?.source_citations) ? r.payload.source_citations : [];
            return (
              <TableRow key={r.id}>
                <TableCell className="font-medium align-top">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{r.supplier_name ?? "—"}</span>
                    {siteType && (
                      <span
                        className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                        title={
                          siteType === "M" ? "Marketplace — online checkout, no signup" :
                          siteType === "MS" ? "Marketplace — checkout after registration" :
                          "Non-marketplace — quote/RFQ only"
                        }
                      >
                        {siteType}
                      </span>
                    )}
                  </div>
                  {r.payload?.supplier_country && (
                    <div className="text-xs text-muted-foreground">{r.payload.supplier_country}</div>
                  )}
                  {sourceUrl && (
                    <a
                      href={sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-xs text-primary hover:underline truncate max-w-[28ch]"
                      title={sourceUrl}
                    >
                      {sourceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
                    </a>
                  )}
                  {citations.length > 1 && (
                    <details className="text-xs text-muted-foreground mt-0.5">
                      <summary className="cursor-pointer hover:text-foreground">{citations.length} sources</summary>
                      <ul className="mt-1 space-y-0.5 max-w-[40ch]">
                        {citations.slice(0, 6).map((u: string, i: number) => (
                          <li key={i} className="truncate">
                            <a href={u} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              {u.replace(/^https?:\/\//, "").slice(0, 50)}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex items-center gap-2">
                    <span>{r.material_name ?? "—"}</span>
                    {r.payload?.catalog_drift === "no_longer_listed" && (
                      <span
                        className="inline-flex items-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        title="Agent 05 detected the supplier dropped this material from their catalog."
                      >
                        drift
                      </span>
                    )}
                  </div>
                  {r.payload?.inci_name && (
                    <div className="text-xs text-muted-foreground truncate max-w-[28ch]">{r.payload.inci_name}</div>
                  )}
                  {isScout && (
                    <span
                      className="mt-1 inline-flex items-center rounded-full bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                      title="Discovered by Agent 03 via web search. Verify the supplier and pricing before promoting."
                    >
                      Scout discovery — needs verification
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs align-top">
                  {signal ? (
                    <>
                      <code>{signal}</code>
                      {signalCount != null && <span className="ml-1">×{signalCount}</span>}
                    </>
                  ) : isScout ? (
                    <code className="text-yellow-700 dark:text-yellow-400">scout</code>
                  ) : "—"}
                </TableCell>
                <TableCell className="align-top"><ConfidenceBadge value={conf} /></TableCell>
                <TableCell className="text-muted-foreground align-top">{r.source ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {r.orgs?.name ?? <span className="italic text-xs">cross-org</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{relativeTime(r.created_at)}</TableCell>
                <TableCell>
                  {r.agent_run_id ? (
                    <a
                      href={`/agents/runs/${r.agent_run_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-muted"
                      title="Open the agent run that created this lead (new tab)"
                    >
                      run ↗
                    </a>
                  ) : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {r.status === "active" ? (
                    <LeadRowActions
                      leadId={r.id}
                      stage={r.stage}
                      status={r.status}
                      hasBlockedReason={!!r.payload?.enrichment_blocked_reason}
                      disabled={!canAct}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground" title={r.drop_reason ?? undefined}>
                      {r.status}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {rowCount === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                No leads match these filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <PaginationBar
        basePath="/work/leads"
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
}) {
  const sp = new URLSearchParams();
  if (p.stage) sp.set("stage", p.stage);
  if (p.drift) sp.set("drift", p.drift);
  if (p.material) sp.set("material", p.material);
  if (p.source) sp.set("source", p.source);
  if (p.status) sp.set("status", p.status);
  if (p.org) sp.set("org", p.org);
  return `/work/leads?${sp.toString()}`;
}

function ConfidenceBadge({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const pct = `${(value * 100).toFixed(0)}%`;
  if (value >= 0.85) return <Badge variant="success">{pct}</Badge>;
  if (value >= 0.65) return <Badge variant="default">{pct}</Badge>;
  return <Badge variant="secondary">{pct}</Badge>;
}
