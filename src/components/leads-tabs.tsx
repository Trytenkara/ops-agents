"use client";

import { useState, Fragment } from "react";
import { cn, relativeTime } from "@/lib/utils";
import { LeadsList } from "@/components/leads-list";
import { MarketplacePricing } from "@/components/marketplace-pricing";
import { OutreachTrackerPanel } from "@/components/outreach-tracker-panel";
import { leadMarketKind } from "@/components/lead-rich-row";
import type { OutreachTracker } from "@/lib/outreach-tracker";
import type { RunStat } from "@/components/agent-runs-strip";
import type { CaseDims } from "@/lib/marketplace-case-dims";

type Tab = "all" | "raw" | "enriched" | "ready" | "held" | "marketplace" | "outreach" | "removed";

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
  tracker,
  runs = [],
  orgClients = [],
  tagsByMaterialId = {},
  dimsByPack = {},
}: {
  rows: any[];
  removedRows?: any[];
  canAct: boolean;
  slug: string;
  orgId?: string;
  operatorOptions?: { id: string; name: string }[];
  tracker: OutreachTracker;
  runs?: RunStat[];
  orgClients?: { id: string; name: string }[];
  tagsByMaterialId?: Record<string, string>; // tenkara_material_id → org_client_id
  dimsByPack?: Record<string, CaseDims>;
}) {
  const [clientFilter, setClientFilter] = useState("all");

  // Apply client filter before everything else — counts, stage cards, and the list
  // all reflect the selected client's materials only.
  const visibleRows = clientFilter === "all"
    ? rows
    : rows.filter((r: any) => r.material_id && tagsByMaterialId[r.material_id] === clientFilter);

  const marketCount = visibleRows.filter(
    (r) => (r.market_kind ?? leadMarketKind(r.payload?.site_type)) === "marketplace"
  ).length;
  const trackerCount = tracker.materials.length;
  const runByLabel = new Map(runs.map((r) => [r.label, r]));

  // Live per-stage counts off the filtered lead set.
  const stageCount = (key: Tab): number => {
    if (key === "held") return visibleRows.filter((r) => r.needs_material_name).length;
    const stage = PIPELINE.find((p) => p.key === key)?.stage;
    return visibleRows.filter((r) => r.stage === stage).length;
  };

  const [tab, setTab] = useState<Tab>(rows.length === 0 && trackerCount > 0 ? "outreach" : "all");

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

  const dotFor = (status: string | null | undefined) =>
    status === "failure" ? "bg-destructive" : status === "partial" ? "bg-yellow-500" : "bg-emerald-500";

  return (
    <div className="space-y-4">
      {orgClients.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="all">All clients</option>
            {orgClients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {clientFilter !== "all" && (
            <span className="text-xs text-muted-foreground">
              {visibleRows.length} of {rows.length} leads
            </span>
          )}
        </div>
      )}
      {/* Live sourcing pipeline — stage cards double as tabs. */}
      <div className="rounded-xl border border-border bg-gradient-to-br from-secondary/40 to-secondary/10 p-3">
        <div className="mb-2.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Live sourcing pipeline
        </div>
        <div className="flex flex-wrap items-stretch gap-1.5">
          {PIPELINE.map((s, i) => {
            const active = tab === s.key;
            const run = s.runLabel ? runByLabel.get(s.runLabel) : undefined;
            const count = stageCount(s.key);
            const empty = count === 0;
            return (
              <Fragment key={s.key}>
                <button
                  type="button"
                  onClick={() => setTab(s.key)}
                  className={cn(
                    "flex min-w-[9rem] flex-1 flex-col gap-1 rounded-lg border px-3.5 py-2.5 text-left transition-all",
                    active
                      ? "border-primary/50 bg-card shadow-sm ring-1 ring-primary/30"
                      : "border-border bg-card/50 hover:bg-card hover:shadow-sm",
                    empty && !active && "opacity-55"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={cn("inline-block h-2 w-2 rounded-full", empty ? "bg-muted-foreground/30" : s.dot, active && "animate-pulse")} />
                    <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}</span>
                  </div>
                  <div className={cn("text-2xl font-semibold leading-none tabular-nums", empty && "text-muted-foreground")}>{count}</div>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    {run ? (
                      <>
                        <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotFor(run.status))} />
                        <span>{s.agent.split(" · ")[0]} · {run.at ? relativeTime(run.at) : "idle"}</span>
                      </>
                    ) : (
                      <span>{s.agent}</span>
                    )}
                  </div>
                </button>
                {i < PIPELINE.length - 1 && (
                  <div className="flex items-center px-0.5 text-muted-foreground/40" aria-hidden>
                    →
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* Lenses over the same client. Export lives with the filters below. */}
      <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-1">
        {tabBtn("all", "All leads", visibleRows.length)}
        {tabBtn("marketplace", "Marketplace pricing", marketCount)}
        {tabBtn("outreach", "Outreach", trackerCount)}
        {tabBtn("removed", "Removed / filtered out", removedRows.length)}
      </div>

      {tab === "all" && (
        <LeadsList rows={visibleRows} canAct={canAct} slug={slug} orgId={orgId} operatorOptions={operatorOptions} />
      )}
      {(tab === "raw" || tab === "enriched" || tab === "ready" || tab === "held") && (
        <LeadsList
          rows={visibleRows}
          canAct={canAct}
          slug={slug}
          orgId={orgId}
          operatorOptions={operatorOptions}
          forceStage={PIPELINE.find((p) => p.key === tab)!.stage}
        />
      )}
      {tab === "removed" &&
        (removedRows.length > 0 ? (
          <>
            <p className="text-sm text-muted-foreground -mb-1">
              Leads that left the pipeline — dropped, deduped, filtered out (freight/logistics), or suppressed before outreach (do-not-contact / excluded country / prior relationship). Each row shows the reason.
            </p>
            <LeadsList rows={removedRows} canAct={false} slug={slug} orgId={orgId} operatorOptions={operatorOptions} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground py-4">Nothing has been removed or filtered out for this client yet.</p>
        ))}
      {tab === "marketplace" && <MarketplacePricing rows={visibleRows} canAct={canAct} slug={slug} dimsByPack={dimsByPack} />}
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
