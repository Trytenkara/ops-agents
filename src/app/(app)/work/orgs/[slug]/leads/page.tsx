import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/utils";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { ListPageHeader } from "@/components/list-page-header";
import { LeadsTabs } from "@/components/leads-tabs";
import { SuppliersCsvUpload } from "@/components/suppliers-csv-upload";
import { resolveMaterialGrades, resolveSupplierMarketplace, resolveMaterialNames } from "@/lib/tenkara-names";
import { leadMarketKind } from "@/components/lead-rich-row";
import { getOrgOperatorPool, pickSupplierOperator, operatorBySupplier, getSupplierAssignments } from "@/lib/operator-assignment";
import { existingQuotesForOrg, type ExistingQuote } from "@/agents-runtime/agents/lead-creator/sql";
import { orgDisplayName } from "@/lib/org-display";
import { AgentRunsStrip, type RunStat } from "@/components/agent-runs-strip";
import { RunNowButton } from "@/components/run-now-button";
import { MaterialFlagsPrompt, type MaterialFlag } from "@/components/material-flags-prompt";
import { getOutreachTracker } from "@/lib/outreach-tracker";
import { OutreachTrackerPanel } from "@/components/outreach-tracker-panel";

export const dynamic = "force-dynamic";

export default async function OrgLeadsPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, display_name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();
  const orgName = orgDisplayName(org);

  // Recent fleet activity — latest run per key sourcing agent (fleet-level; while
  // ONLY_ORG scopes the fleet to one org this reflects that org).
  const RUN_LABELS: Record<string, string> = {
    "agent-03-lead-creator": "Discovery",
    "agent-06-enrichment": "Enrichment",
    "agent-04-outreach": "Outreach",
  };
  const { data: runRows } = await admin
    .from("agent_runs")
    .select("summary, status, run_started_at, agents!inner(slug)")
    .in("agents.slug", Object.keys(RUN_LABELS))
    .order("run_started_at", { ascending: false })
    .limit(40);
  const latestBySlug = new Map<string, RunStat>();
  for (const r of (runRows ?? []) as any[]) {
    const slug = r.agents?.slug;
    if (slug && !latestBySlug.has(slug)) {
      latestBySlug.set(slug, { label: RUN_LABELS[slug], summary: r.summary, status: r.status, at: r.run_started_at });
    }
  }
  const runStats = Object.keys(RUN_LABELS)
    .map((s) => latestBySlug.get(s))
    .filter(Boolean) as RunStat[];

  const { data: flagRows } = await admin
    .from("material_name_flags")
    .select("id, wrong_name, suggested_name")
    .eq("org_id", org.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  const materialFlags = (flagRows ?? []) as MaterialFlag[];

  const { data: rows } = await admin
    .from("leads_in_flight")
    .select(
      "id, org_id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, drop_reason, confidence_score, agent_run_id, created_at, orgs(slug, name)"
    )
    .eq("org_id", org.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(200);
  let leads = (rows ?? []) as any[];

  // Grade + name live on the Tenkara material — resolve by material_id and
  // attach. A lead's stored material_name can be blank/stale (unbranded
  // materials carry trade_name=''), so we re-derive the authoritative name here.
  let leadGrades = new Map<string, string>();
  let leadMarketplace = new Map<string, boolean>();
  let leadNames = new Map<string, string>();
  try {
    [leadGrades, leadMarketplace, leadNames] = await Promise.all([
      resolveMaterialGrades(leads.map((r) => r.material_id).filter(Boolean)),
      resolveSupplierMarketplace(leads.map((r) => r.supplier_id).filter(Boolean)),
      resolveMaterialNames(leads.map((r) => r.material_id).filter(Boolean)),
    ]);
  } catch {
    // Tenkara unreachable — fall back to payload grade / site_type in the row.
  }
  // market_kind: prefer the supplier's is_marketplace flag (covers platform-DB
  // leads), fall back to the scanner's site_type for scout leads.
  // Owning operator per lead, sticky by supplier within the org.
  // A lead's operator is the SAME as its supplier's operator — assigning here
  // writes the supplier assignment, so lead ownership and supplier ownership stay
  // in lockstep. autoName = sticky-random default; assignedId = a manual claim.
  const operatorPool = await getOrgOperatorPool(admin, org.id);
  const supplierIds = leads.map((r) => r.supplier_id).filter(Boolean) as string[];
  const autoOwners = operatorBySupplier(operatorPool, supplierIds);
  const supplierAssignments = await getSupplierAssignments(admin, org.id).catch(() => new Map<string, string>());
  const operatorOptions = operatorPool.map((op) => ({ id: op.id, name: op.name }));
  leads = leads.map((r) => {
    const flag = r.supplier_id ? leadMarketplace.get(r.supplier_id) : undefined;
    const market_kind =
      flag === true ? "marketplace" : flag === false ? "direct" : leadMarketKind(r.payload?.site_type);
    const operator_name = pickSupplierOperator(operatorPool, r.supplier_id)?.name ?? null;
    const operator_assigned_id = r.supplier_id ? supplierAssignments.get(r.supplier_id) ?? null : null;
    const operator_auto_name = r.supplier_id ? autoOwners[r.supplier_id]?.name ?? null : null;
    const resolvedName =
      (r.material_name && r.material_name.trim()) ||
      (r.material_id ? leadNames.get(r.material_id) ?? null : null);
    return {
      ...r,
      material_name: resolvedName ?? r.material_name,
      needs_material_name: !resolvedName,
      grade: r.material_id ? leadGrades.get(r.material_id) ?? null : null,
      market_kind,
      operator_name,
      operator_assigned_id,
      operator_auto_name,
    };
  });

  // Leads whose material has no name anywhere (stored or Tenkara). Outreach holds
  // these — surface them so ops can add the name in Tenkara before re-running.
  const leadsNeedingName = leads.filter((r) => r.needs_material_name);

  // Promote/Drop gating: the operator can act if they see all orgs or this org
  // is in their assignment set, and they hold an acting role.
  const session = (await getSession())!;
  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  // Existing saved quotes we already have for this org's materials (Ben's recco)
  // — context, not new leads. Tenkara is read-only + occasionally slow, so fall
  // back to an empty list rather than failing the page.
  let quotes: ExistingQuote[] = [];
  if (org.tenkara_org_id) {
    quotes = await existingQuotesForOrg(org.tenkara_org_id).catch(() => []);
  }

  // Per-material outreach funnel (drafts / to whom / QA held / manual / skipped).
  const tracker = await getOutreachTracker(admin, org.id).catch(() => ({
    materials: [],
    totals: { emails: 0, qaFlagged: 0, manual: 0, skipped: 0, suppliers: 0 },
    marketplace: { total: 0, emailed: 0, manual: 0, needsPull: 0, pending: 0 },
  }));

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Leads"
        description={`Suppliers discovered for ${orgName}. Export the CSV for the manual supplier-sourcing index.`}
        collectedBy="Agent 03 (Lead Creator) + Agent 06 (Enrichment)"
        actions={
          canAct ? (
            <div className="flex items-center gap-2">
              <RunNowButton agentSlug="agent-03-lead-creator" isRunning={false} label="Run discovery" stayOnPage />
              <RunNowButton agentSlug="agent-04-outreach" isRunning={false} label="Run outreach" stayOnPage />
              <SuppliersCsvUpload orgId={org.id} />
            </div>
          ) : undefined
        }
      />
      <AgentRunsStrip runs={runStats} />
      <MaterialFlagsPrompt flags={materialFlags} />
      {leadsNeedingName.length > 0 && (
        <div className="rounded-lg border border-red-300/60 bg-red-500/10 px-4 py-3 space-y-1">
          <div className="text-xs uppercase tracking-wider font-semibold text-red-800 dark:text-red-300">
            {leadsNeedingName.length} lead{leadsNeedingName.length > 1 ? "s" : ""} held — missing material name
          </div>
          <p className="text-sm text-muted-foreground">
            Outreach won&apos;t draft these until the material has a name. Add the material name in Tenkara, then re-run
            discovery/outreach. Affected suppliers:{" "}
            <span className="text-foreground">
              {Array.from(new Set(leadsNeedingName.map((r) => r.supplier_name).filter(Boolean))).slice(0, 8).join(", ")}
              {leadsNeedingName.length > 8 ? "…" : ""}
            </span>
          </p>
        </div>
      )}
      {leads.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No active leads for this org.</p>
      ) : (
        <LeadsTabs rows={leads} canAct={canAct} slug={org.slug} orgId={org.id} operatorOptions={operatorOptions} />
      )}

      <OutreachTrackerPanel tracker={tracker} />

      <section className="space-y-2 pt-2">
        <h2 className="font-serif text-xl tracking-tight">
          Existing saved quotes <span className="text-muted-foreground text-base">· {quotes.length}</span>
        </h2>
        <p className="text-xs text-muted-foreground">
          Quotes already in the database for {orgName}&apos;s materials — so you can see what&apos;s covered before sourcing more. Re-quoting these is Agent 02&apos;s job, not new outreach.
        </p>
        {quotes.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Supplier</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Lead time</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Quoted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotes.map((q) => (
                <TableRow key={q.quote_id}>
                  <TableCell className="font-medium">{q.material_name ?? "—"}</TableCell>
                  <TableCell>{q.supplier_name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{q.price != null ? `$${q.price}${q.uom ? `/${q.uom}` : ""}` : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{q.lead_time_days != null ? `${q.lead_time_days}d` : "—"}</TableCell>
                  <TableCell><Badge variant="secondary">{q.status ?? "—"}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{q.quote_date ? relativeTime(q.quote_date) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No saved quotes for this org&apos;s materials yet.</p>
        )}
      </section>
    </div>
  );
}
