import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";

import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { ListPageHeader } from "@/components/list-page-header";
import { LeadsTabs } from "@/components/leads-tabs";
import { loadSupplierDocIndex } from "@/lib/supplier-doc-index";
import { SuppliersCsvUpload } from "@/components/suppliers-csv-upload";
import { resolveMaterialGrades, resolveSupplierMarketplace, resolveMaterialNames } from "@/lib/tenkara-names";
import { correctMaterialSpelling } from "@/lib/material-spelling";
import { leadMarketKind } from "@/lib/lead-market";
import { computeLeadFlags } from "@/lib/lead-flags";
import { getClientRequirements, dealbreakerCertNames } from "@/lib/tenkara-requirements";
import { loadMarketplaceCaseDims } from "@/lib/marketplace-case-dims";
import { getOrgAssignmentContext, autoOperator, overridesAuto } from "@/lib/operator-assignment";

import { orgDisplayName } from "@/lib/org-display";
import { getSupplierProfiles } from "@/lib/supplier-profiles";
import { getMarketplaceAccounts } from "@/lib/marketplace-accounts";
import { CasesSection } from "@/components/cases-section";
import { loadOrgCases, caseCategory } from "@/lib/org-cases";
import { AgentRunsStrip, type RunStat } from "@/components/agent-runs-strip";
import { RunNowButton } from "@/components/run-now-button";
import { MaterialFlagsPrompt, type MaterialFlag } from "@/components/material-flags-prompt";
import { MaterialMergePrompt, type MaterialMergeFlag } from "@/components/material-merge-prompt";
import { getOutreachTracker } from "@/lib/outreach-tracker";
import { DensityToggle } from "@/components/density-toggle";
import { Tooltip } from "@/components/ui/tooltip";

export const dynamic = "force-dynamic";

export default async function OrgLeadsPage({ params }: { params: { slug: string } }) {
  const admin = createAdminClient();
  const marketplaceDims = await loadMarketplaceCaseDims(admin);
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

  const { data: mergeRows } = await admin
    .from("material_merge_flags")
    .select("id, keep_name, keep_grades, drop_name, drop_grades, reason, drop_lead_count, shared_supplier_count")
    .eq("org_id", org.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  const mergeFlags = (mergeRows ?? []) as MaterialMergeFlag[];

  // PostgREST hard-caps a single response at 1000 rows, so a plain .limit() can't
  // return every active lead (a busy org runs to ~1k+ across all its materials).
  // Page through with .range() so the tab counts and lists reflect the real total
  // — otherwise the page silently showed only the newest 200.
  const LEAD_PAGE = 1000;
  const LEAD_HARD_CAP = 5000; // safety bound against a pathological org
  const rawRows: any[] = [];
  for (let from = 0; from < LEAD_HARD_CAP; from += LEAD_PAGE) {
    const { data: page } = await admin
      .from("leads_in_flight")
      .select(
        "id, org_id, supplier_name, supplier_id, assigned_operator_id, assigned_operator_at, material_name, material_id, stage, status, source, payload, drop_reason, confidence_score, agent_run_id, created_at, updated_at, orgs(slug, name)"
      )
      .eq("org_id", org.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .range(from, from + LEAD_PAGE - 1);
    if (!page || page.length === 0) break;
    rawRows.push(...page);
    if (page.length < LEAD_PAGE) break;
  }
  let leads = rawRows;

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
  // leads), fall back to the scanner's site_type for scout leads. Aggregators are
  // the exception: the flag is a marketplace/direct boolean with no way to express
  // one, so a site_type of A wins over it.
  // Owning operator per lead, sticky by supplier within the org.
  // A lead's operator is the SAME as its supplier's operator — assigning here
  // writes the supplier assignment, so lead ownership and supplier ownership stay
  // in lockstep. autoName = sticky-random default; assignedId = a manual claim.
  const assignmentCtx = await getOrgAssignmentContext(admin, org.id);
  const supplierIds = leads.map((r) => r.supplier_id).filter(Boolean) as string[];
  const supplierAssignments = assignmentCtx.manual;
  const operatorOptions = assignmentCtx.pool.map((op) => ({ id: op.id, name: op.name }));
  const operatorNameById = new Map(assignmentCtx.pool.map((op) => [op.id, op.name]));

  // Tenkara inbox assignee: who the outreach agent actually assigned the Tenkara
  // conversation to (from draft_references.assigned_operator). This may differ from
  // the current supplier_assignment if someone reassigned after the draft was created.
  // Most-recent draft per supplier wins; keyed by supplier_id.
  const tenkaraAssigneeBySupplier = new Map<string, string>(); // supplier_id → name
  if (supplierIds.length) {
    const { data: draftRefs } = await admin
      .from("draft_references")
      .select("supplier_id, assigned_operator")
      .eq("org_id", org.id)
      .in("supplier_id", supplierIds)
      .not("assigned_operator", "is", null)
      .order("created_at", { ascending: false });
    for (const ref of draftRefs ?? []) {
      const sid = (ref as any).supplier_id as string;
      const opId = (ref as any).assigned_operator as string;
      if (!tenkaraAssigneeBySupplier.has(sid)) {
        const name = operatorNameById.get(opId);
        if (name) tenkaraAssigneeBySupplier.set(sid, name);
      }
    }
  }

  // Client's dealbreaker certifications (read-only from Tenkara), used to flag
  // leads whose supplier doesn't list a required cert. Best-effort: on failure
  // the flag simply doesn't fire.
  const dealbreakerCerts = org.tenkara_org_id
    ? await getClientRequirements(org.tenkara_org_id)
        .then(dealbreakerCertNames)
        .catch(() => [] as string[])
    : ([] as string[]);

  leads = leads.map((r) => {
    const flag = r.supplier_id ? leadMarketplace.get(r.supplier_id) : undefined;
    const siteKind = leadMarketKind(r.payload?.site_type);
    const market_kind =
      siteKind === "aggregator" ? "aggregator" : flag === true ? "marketplace" : flag === false ? "direct" : siteKind;
    // A supplier-backed lead's owner syncs with its supplier (supplier_assignment);
    // a Scout lead (no supplier_id) uses its own lead-level manual claim. In both
    // cases the auto default is sticky-random over the pool — keyed by supplier_id
    // when present, else the EMAIL consolidation key so every material row of one
    // Scout supplier resolves to the SAME operator (matching the single consolidated
    // outreach thread), falling back to the lead id only when there's no email.
    // Same key outreach uses, so the displayed owner matches who gets the drafts.
    const scoutAutoKey = (() => {
      const em = String(r.payload?.supplier_contact_email ?? "").trim().toLowerCase();
      return em ? `e:${em}` : r.id;
    })();
    const operator_assigned_id = r.supplier_id
      ? supplierAssignments.get(r.supplier_id) ?? null
      : r.assigned_operator_id ?? null;
    // Empty when the client runs manual assignment, or when this lead's market
    // kind sits outside the client's auto scope.
    const operator_auto_name = autoOperator(assignmentCtx, r.supplier_id ?? scoutAutoKey, market_kind)?.name ?? null;
    // Static label (rows without an assign control): a manual claim wins, except
    // under "auto, reassign all", where the auto owner is who agents route to —
    // unless the claim was made after that spread, i.e. someone corrected it.
    const claimedName = operator_assigned_id ? operatorNameById.get(operator_assigned_id) ?? null : null;
    const claimedAt = r.supplier_id ? assignmentCtx.manualAt.get(r.supplier_id) ?? null : r.assigned_operator_at ?? null;
    const operator_name = overridesAuto(assignmentCtx, claimedAt)
      ? claimedName ?? operator_auto_name
      : operator_auto_name ?? claimedName;
    const resolvedName = correctMaterialSpelling(
      (r.material_name && r.material_name.trim()) ||
        (r.material_id ? leadNames.get(r.material_id) ?? null : null)
    );
    const tenkara_assignee_name = r.supplier_id
      ? tenkaraAssigneeBySupplier.get(r.supplier_id) ?? null
      : null;
    return {
      ...r,
      material_name: resolvedName ?? correctMaterialSpelling(r.material_name),
      needs_material_name: !resolvedName,
      grade: r.material_id ? leadGrades.get(r.material_id) ?? null : null,
      market_kind,
      operator_name,
      operator_assigned_id,
      operator_auto_name,
      tenkara_assignee_name,
      flags: computeLeadFlags(r.payload, { dealbreakerCerts }),
    };
  });

  // Leads whose material has no name anywhere (stored or Tenkara). Outreach holds
  // these — surface them so ops can add the name in Tenkara before re-running.
  const leadsNeedingName = leads.filter((r) => r.needs_material_name);

  // Removed / filtered-out leads: GENUINE exits only — terminal (manual drops,
  // freight/non-material filter), dropped-as-duplicate (dedup_canonical_name /
  // duplicate_open_case), or active leads outreach suppressed (do-not-contact /
  // excluded country / prior relationship). Deliberately EXCLUDES leads routed
  // to manual handling (payload.drop_reason=manual_outreach_case) and
  // escalated_to_case — those are active work shown under the Outreach tab, not
  // removals. Loaded separately since the main list is active-only; capped at 500.
  const { data: removedRaw } = await admin
    .from("leads_in_flight")
    .select(
      "id, org_id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, drop_reason, confidence_score, agent_run_id, created_at, updated_at, orgs(slug, name)"
    )
    .eq("org_id", org.id)
    .or("status.eq.terminal,and(status.eq.dropped,drop_reason.in.(dedup_canonical_name,duplicate_open_case)),payload->>outreach_suppressed.not.is.null")
    .order("created_at", { ascending: false })
    .limit(500);
  const removedRows = (removedRaw ?? []).map((r) => ({
    ...r,
    material_name: correctMaterialSpelling(r.material_name) ?? r.material_name,
  }));

  // Promote/Drop gating: the operator can act if they see all orgs or this org
  // is in their assignment set, and they hold an acting role.
  const session = (await getSession())!;
  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  // Per-material outreach funnel (drafts / to whom / QA held / manual / skipped).
  const tracker = await getOutreachTracker(admin, org.id).catch(() => ({
    materials: [],
    totals: { emails: 0, qaFlagged: 0, manual: 0, skipped: 0, suppliers: 0 },
    marketplace: { total: 0, emailed: 0, manual: 0, needsPull: 0, pending: 0 },
  }));

  // Supplier profiles for the supplier-centric view (approval tracking)
  const supplierProfiles = await getSupplierProfiles(admin, org.id).catch(() => []);

  // Qualification documents captured for this org, so the leads download carries
  // the CoA/SDS/TDS facts and not just the lead's own fields.
  const supplierDocs = await loadSupplierDocIndex(admin, org.id).catch(() => ({}));

  // Marketplace logins (host, credentials, lifecycle status, who created them) —
  // both the accounts the fleet provisioned to pull gated prices and the ones
  // ops entered by hand in the Supplier Validation tab.
  const marketplaceAccounts = await getMarketplaceAccounts(admin, org.id).catch(() => []);

  // Client folders — for the client filter on the leads list.
  const [{ data: tagRows }, { data: orgClientRows }] = await Promise.all([
    admin.from("material_client_tags").select("tenkara_material_id, org_client_id").eq("org_id", org.id),
    admin.from("org_clients").select("id, name").eq("org_id", org.id).order("name"),
  ]);
  const tagsByMaterialId: Record<string, string> = {};
  for (const t of tagRows ?? []) {
    if (t.org_client_id) tagsByMaterialId[t.tenkara_material_id] = t.org_client_id;
  }
  const orgClients = (orgClientRows ?? []).map((r: any) => ({ id: r.id as string, name: r.name as string }));

  // Supplier-side escalations (bounced/no-contact leads, stale leads) surfaced in
  // the "Supplier Escalations" tab alongside the leads the fleet stalled on.
  const { openRows: caseOpen, resolvedRows: caseResolved } = await loadOrgCases(admin, org.id);
  const supplierCasesOpen = caseOpen.filter((c) => caseCategory(c.type) === "supplier");
  const supplierCasesResolved = caseResolved.filter((c) => caseCategory(c.type) === "supplier");
  const enrichmentCases =
    supplierCasesOpen.length > 0 || supplierCasesResolved.length > 0 ? (
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Escalations</h3>
          <p className="text-sm text-muted-foreground">
            Supplier leads that need a human: a bounced or missing contact to re-enter, or a lead that stalled with no
            movement. Take the recommended action and resolve.
          </p>
        </div>
        <CasesSection openRows={supplierCasesOpen} resolvedRows={supplierCasesResolved} slug={org.slug} emptyLabel="No supplier escalations right now." />
      </section>
    ) : null;

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Agent Supplier Leads"
        description={`Supplier-centric view of leads for ${orgName}. Track supplier qualification, approval data, and sourcing progress.`}
        collectedBy="Agent 03 (Lead Creator) + Agent 06 (Enrichment)"
        actions={
          canAct ? (
            <div className="flex items-center gap-2">
              <Tooltip content="Kick off Agent 03 to search the web for new suppliers of this client's materials.">
                <RunNowButton agentSlug="agent-03-lead-creator" isRunning={false} label="Run discovery" stayOnPage />
              </Tooltip>
              <Tooltip content="Kick off Agent 04 to draft intro emails to enriched suppliers that have a contact.">
                <RunNowButton agentSlug="agent-04-outreach" isRunning={false} label="Run outreach" stayOnPage />
              </Tooltip>
              <Tooltip content="Bulk-add suppliers (columns: supplier, email, material) straight into this client's outreach queue.">
                <SuppliersCsvUpload orgId={org.id} />
              </Tooltip>
            </div>
          ) : undefined
        }
      />
      <div className="flex justify-end -mt-2">
        <DensityToggle />
      </div>
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
      <LeadsTabs rows={leads} removedRows={removedRows} canAct={canAct} slug={org.slug} orgId={org.id} operatorOptions={operatorOptions} currentUserName={assignmentCtx.pool.find((op) => op.id === session.userId)?.name ?? null} tracker={tracker} runs={runStats} orgClients={orgClients} tagsByMaterialId={tagsByMaterialId} dimsByPack={marketplaceDims} supplierProfiles={supplierProfiles} marketplaceAccounts={marketplaceAccounts} enrichmentCases={enrichmentCases} supplierDocs={supplierDocs} mergePrompt={<MaterialMergePrompt flags={mergeFlags} />} />
    </div>
  );
}
