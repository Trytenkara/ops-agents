"use client";

import { useState } from "react";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { LeadsList } from "@/components/leads-list";
import type { SupplierDocIndex } from "@/lib/supplier-doc-index";
import { MarketplacePricing } from "@/components/marketplace-pricing";
import { OutreachTrackerPanel } from "@/components/outreach-tracker-panel";
import { SupplierLeadsView } from "@/components/supplier-leads-view";
import type { MarketplaceAccount } from "@/components/marketplace-logins";
import { leadMarketKind, isOperatorDropped } from "@/components/lead-rich-row";
import type { OutreachTracker } from "@/lib/outreach-tracker";
import type { CaseDims } from "@/lib/marketplace-case-dims";
import type { SupplierProfile } from "@/lib/supplier-profiles";
import { DuplicateReviewSection, type DuplicateReviewRow } from "@/components/duplicate-review-section";

type Tab = "all" | "raw" | "enriched" | "ready" | "held" | "marketplace" | "aggregator" | "outreach" | "removed" | "stuck" | "duplicates" | "dropped" | "suppliers";

// The sourcing pipeline as a live funnel: each stage is the output of one agent,
// so surfacing raw -> enriched -> ready-to-send -> held (with counts + the
// producing agent's last run) reads as "the fleet is working this client now".
// Each card doubles as a tab that filters the list to that stage.
const PIPELINE: {
  key: Extract<Tab, "raw" | "enriched" | "ready" | "held">;
  // Stage value LeadsList filters on (via forceStage).
  stage: string;
  label: string;
  agent: string;
  // RunStat.label of the agent that produces this stage (null = no agent).
  runLabel: string | null;
  dot: string;
}[] = [
  { key: "raw", stage: "raw", label: "Raw", agent: "Agent 03 · Discovery", runLabel: "Discovery", dot: "bg-slate-400" },
  { key: "enriched", stage: "enriched", label: "Enriched", agent: "Agent 06 · Enrichment", runLabel: "Enrichment", dot: "bg-blue-500" },
  { key: "ready", stage: "ready_for_outreach", label: "Ready to send", agent: "Agent 04 · Outreach", runLabel: "Outreach", dot: "bg-emerald-500" },
  { key: "held", stage: "held", label: "Held for review", agent: "Needs a human", runLabel: null, dot: "bg-amber-500" },
];

export function LeadsTabs({
  rows,
  removedRows = [],
  canAct,
  slug,
  orgId,
  operatorOptions,
  currentUserName = null,
  tracker,
  initialTab = "suppliers",
  orgClients = [],
  tagsByMaterialId = {},
  dimsByPack = {},
  supplierProfiles = [],
  profileOperators = {},
  marketplaceAccounts = [],
  enrichmentCases = null,
  enrichmentCaseCount = 0,
  supplierDocs,
  mergePrompt = null,
}: {
  rows: any[];
  removedRows?: any[];
  canAct: boolean;
  slug: string;
  orgId?: string;
  operatorOptions?: { id: string; name: string }[];
  currentUserName?: string | null;
  tracker: OutreachTracker;
  initialTab?: Tab;
  orgClients?: { id: string; name: string }[];
  tagsByMaterialId?: Record<string, string>; // tenkara_material_id → org_client_id
  dimsByPack?: Record<string, CaseDims>;
  supplierProfiles?: SupplierProfile[];
  profileOperators?: Record<string, string>;
  marketplaceAccounts?: MarketplaceAccount[];
  enrichmentCases?: React.ReactNode;
  enrichmentCaseCount?: number;
  supplierDocs?: SupplierDocIndex;
  // Sits under each tab's own filter row, so it reads as a note on the list
  // being shown rather than a page-level banner above the tabs.
  mergePrompt?: React.ReactNode;
}) {
  const [clientFilter, setClientFilter] = useState("all");
  // Operators asked to work only their own book: a client's full lead set runs to
  // thousands and an operator owns a fraction of it.
  const [operatorFilter, setOperatorFilter] = useState("all");
  // Owners actually present in this lead set, not the whole pool: a filter that
  // only ever returns zero rows is noise.
  const ownerNames = [...new Set(rows.map((r: any) => r.operator_name).filter(Boolean) as string[])].sort();

  // Applied before everything else — counts, stage cards, and the list all reflect
  // the current selection. Dealbreaker fit is deliberately NOT here: it lives as a
  // "Meets dealbreakers first" option in each tab's own Sort by control, so it
  // orders a tab without hiding rows from the pipeline counts above.
  const byClient = clientFilter === "all"
    ? rows
    : rows.filter((r: any) => r.material_id && tagsByMaterialId[r.material_id] === clientFilter);
  const visibleRows =
    operatorFilter === "all"
      ? byClient
      : operatorFilter === "unassigned"
        ? byClient.filter((r: any) => !r.operator_name)
        : byClient.filter((r: any) => r.operator_name === operatorFilter);

  // Split the removed set: operator-dropped leads get their own tab; everything
  // else (auto-dropped, deduped, freight-filtered, suppressed) needs a human to
  // move it forward.
  const droppedRows = removedRows.filter((r: any) => isOperatorDropped(r));
  const enrichmentRows = removedRows.filter((r: any) => !isOperatorDropped(r));

  // Active marketplace leads whose price auto-scrape gave up (needs_manual_pull).
  // They stay in Marketplace pricing so an operator can type a price in, but also
  // surface here with a red "Unable to scrape" flag so the un-fillable ones aren't
  // lost among filled rows. Deduped against the removed set (a lead later dropped
  // shows under its drop reason instead).
  const removedIds = new Set(removedRows.map((r: any) => r.id));
  const kindOf = (r: any) => r.market_kind ?? leadMarketKind(r.payload?.site_type);
  const needsPriceInput = visibleRows.filter(
    (r: any) =>
      !removedIds.has(r.id) &&
      (kindOf(r) === "marketplace" || kindOf(r) === "aggregator") &&
      r.payload?.marketplace_pull?.status === "needs_manual_pull"
  );
  const enrichmentDisplay = [...enrichmentRows, ...needsPriceInput];

  // Leads Agent 20 held back because they look like a supplier this client
  // already has. They are active but parked outside the stages Tenkara promotes,
  // so nothing is created while they wait for an operator's yes/no.
  const duplicateRows: DuplicateReviewRow[] = visibleRows
    .filter((r: any) => r.payload?.duplicate_review?.pending)
    .map((r: any) => ({
      leadId: r.id,
      supplierName: r.supplier_name ?? "Unnamed supplier",
      materialName: r.material_name ?? null,
      domain: r.payload.duplicate_review.domain,
      existingNames: r.payload.duplicate_review.existing_supplier_names ?? [],
      website: r.payload.supplier_website ?? null,
      parkedAt: r.payload.duplicate_review.parked_at ?? null,
    }));

  const marketCount = visibleRows.filter((r) => kindOf(r) === "marketplace").length;
  const aggregatorCount = visibleRows.filter((r) => kindOf(r) === "aggregator").length;
  const trackerCount = tracker.materials.length;

  const supplierCount = new Set(visibleRows.map((r: any) => r.supplier_id ?? r.supplier_name).filter(Boolean)).size;

  // Per-stage counts for the Pipeline group, matching LeadsList's forceStage
  // filter exactly (held = needs_material_name, ready = ready_for_outreach).
  const stageCount = (key: Extract<Tab, "raw" | "enriched" | "ready" | "held">) => {
    const stage = PIPELINE.find((p) => p.key === key)!.stage;
    return stage === "held"
      ? visibleRows.filter((r: any) => r.needs_material_name).length
      : visibleRows.filter((r: any) => r.stage === stage).length;
  };

  const [tab, setTab] = useState<Tab>(initialTab);

  const tabBtn = (key: Tab, label: string, count?: number) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        tab === key ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      {count != null && <span className="ml-1.5 text-xs text-muted-foreground">{count}</span>}
    </button>
  );

  // A labeled cluster of tabs. The small caption turns the flat chip run into
  // named families (Pipeline / Work / Pricing / Exceptions).
  const tabGroup = (label: string, children: React.ReactNode) => (
    <div className="flex flex-col gap-1">
      <span className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{label}</span>
      <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-1">{children}</div>
    </div>
  );

  // These filter every tab, but they render inside the active tab's own filter
  // row so an operator reads one filter bar instead of a stray row above the page.
  const pageFilters = (orgClients.length > 0 || ownerNames.length > 0) && (
    <>
      {orgClients.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Client</span>
          <Select
            size="sm"
            className="min-w-[10rem]"
            ariaLabel="Filter by client"
            value={clientFilter}
            onValueChange={setClientFilter}
            options={[{ value: "all", label: "All clients" }, ...orgClients.map((c) => ({ value: c.id, label: c.name }))]}
          />
        </label>
      )}
      {ownerNames.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Operator</span>
          <Select
            size="sm"
            className="min-w-[10rem]"
            ariaLabel="Filter by operator"
            value={operatorFilter}
            onValueChange={setOperatorFilter}
            options={[
              { value: "all", label: "All operators" },
              ...(currentUserName && ownerNames.includes(currentUserName)
                ? [{ value: currentUserName, label: `My leads (${currentUserName})` }]
                : []),
              ...ownerNames.filter((n) => n !== currentUserName).map((n) => ({ value: n, label: n })),
              { value: "unassigned", label: "Unassigned" },
            ]}
          />
        </label>
      )}
      {(clientFilter !== "all" || operatorFilter !== "all") && (
        <span className="pb-1.5 text-xs text-muted-foreground">
          {visibleRows.length} of {rows.length} leads
        </span>
      )}
    </>
  );

  return (
    <div className="space-y-4">
      {/* The live sourcing funnel now lives on the org Overview; the stage-filtered
          lists here are reached by deep-linking from those cards (?stage=). */}

      {/* Lenses over the same client, grouped by family so the bar reads as
          Pipeline / Work / Pricing / Exceptions instead of one flat run of chips.
          Pipeline stages are also reached by deep-link from the Overview funnel
          cards (?stage=). Export lives with the filters below. */}
      <div className="flex flex-wrap items-stretch gap-2">
        {tabGroup("Pipeline", (
          <>
            {tabBtn("raw", "Raw", stageCount("raw"))}
            {tabBtn("enriched", "Enriched", stageCount("enriched"))}
            {tabBtn("ready", "Ready", stageCount("ready"))}
            {tabBtn("held", "Held", stageCount("held"))}
          </>
        ))}
        {tabGroup("Work", (
          <>
            {tabBtn("suppliers", "Supplier Validation", supplierCount)}
            {tabBtn("all", "All leads", visibleRows.length)}
          </>
        ))}
        {tabGroup("Pricing", (
          <>
            {tabBtn("marketplace", "Marketplace", marketCount)}
            {tabBtn("aggregator", "Aggregator", aggregatorCount)}
          </>
        ))}
        {tabGroup("Exceptions", (
          <>
            {tabBtn("outreach", "Outreach", trackerCount)}
            {tabBtn("duplicates", "Duplicates", duplicateRows.length)}
            {tabBtn("removed", "Escalations", enrichmentCaseCount)}
            {tabBtn("stuck", "Stuck", enrichmentDisplay.length)}
            {tabBtn("dropped", "Dropped", droppedRows.length)}
          </>
        ))}
      </div>

      {tab === "suppliers" && orgId && (
        <div className="space-y-4">
          <SupplierLeadsView
            rows={visibleRows}
            profiles={supplierProfiles}
            profileOperators={profileOperators}
            marketplaceAccounts={marketplaceAccounts}
            canAct={canAct}
            slug={slug}
            orgId={orgId}
            operatorOptions={operatorOptions}
            banner={mergePrompt}
            filters={pageFilters}
          />
        </div>
      )}
      {tab !== "suppliers" && mergePrompt}
      {tab === "all" && (
        <LeadsList rows={visibleRows} canAct={canAct} slug={slug} orgId={orgId} operatorOptions={operatorOptions} supplierDocs={supplierDocs} filters={pageFilters} />
      )}
      {(tab === "raw" || tab === "enriched" || tab === "ready" || tab === "held") && (
        <LeadsList
          rows={visibleRows}
          canAct={canAct}
          slug={slug}
          orgId={orgId}
          operatorOptions={operatorOptions}
          supplierDocs={supplierDocs}
          forceStage={PIPELINE.find((p) => p.key === tab)!.stage}
          filters={pageFilters}
        />
      )}
      {tab === "duplicates" && <DuplicateReviewSection rows={duplicateRows} canAct={canAct} />}
      {tab === "removed" &&
        (enrichmentCases ?? (
          <p className="text-sm text-muted-foreground py-4">No supplier escalations for this client yet.</p>
        ))}
      {tab === "stuck" &&
        (enrichmentDisplay.length > 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground -mb-1">
              Leads the fleet could not complete on its own: no contact recovered, deduped, freight/logistics filtered, suppressed before outreach (do-not-contact, excluded country, prior relationship), or a marketplace price the auto-scrape couldn&apos;t get (needs a manual price). Each row shows the reason.
            </p>
            <LeadsList rows={enrichmentDisplay} canAct={false} slug={slug} orgId={orgId} operatorOptions={operatorOptions} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground py-4">No stuck leads for this client.</p>
        ))}
      {tab === "dropped" &&
        (droppedRows.length > 0 ? (
          <>
            <p className="text-sm text-muted-foreground -mb-1">
              Leads an operator manually dropped. Each row shows the reason it was dropped.
            </p>
            <LeadsList rows={droppedRows} canAct={false} slug={slug} orgId={orgId} operatorOptions={operatorOptions} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground py-4">No leads have been manually dropped for this client yet.</p>
        ))}
      {tab === "marketplace" && (
        <MarketplacePricing rows={visibleRows} canAct={canAct} slug={slug} dimsByPack={dimsByPack} kind="marketplace" filters={pageFilters} />
      )}
      {tab === "aggregator" && (
        <MarketplacePricing rows={visibleRows} canAct={canAct} slug={slug} dimsByPack={dimsByPack} kind="aggregator" filters={pageFilters} />
      )}
      {tab === "outreach" &&
        (trackerCount > 0 ? (
          <OutreachTrackerPanel tracker={tracker} slug={slug} />
        ) : (
          <p className="text-sm text-muted-foreground py-4">
            No outreach activity yet. Once outreach runs for this client, drafts, skipped leads, and manual cases show up here.
          </p>
        ))}
    </div>
  );
}
