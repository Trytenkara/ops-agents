"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { LeadsList } from "@/components/leads-list";
import { MarketplacePricing } from "@/components/marketplace-pricing";
import { OutreachTrackerPanel } from "@/components/outreach-tracker-panel";
import { LeadsCsvDownload } from "@/components/leads-csv-download";
import { leadMarketKind } from "@/components/lead-rich-row";
import type { OutreachTracker } from "@/lib/outreach-tracker";

type Tab = "all" | "raw" | "marketplace" | "outreach";

// Three lenses over the same client: the full lead list (per supplier), the
// marketplace-only pricing view, and the outreach tracker (per material — what
// actually happened once a material entered outreach).
export function LeadsTabs({
  rows,
  canAct,
  slug,
  orgId,
  operatorOptions,
  tracker,
  materials,
}: {
  rows: any[];
  canAct: boolean;
  slug: string;
  orgId?: string;
  operatorOptions?: { id: string; name: string }[];
  tracker: OutreachTracker;
  materials: string[];
}) {
  const marketCount = rows.filter(
    (r) => (r.market_kind ?? leadMarketKind(r.payload?.site_type)) === "marketplace"
  ).length;
  // Not-enriched = leads Agent 06 hasn't promoted yet (still stage=raw). These
  // have no probed contact email, so outreach can't draft them until enriched.
  const rawCount = rows.filter((r) => r.stage === "raw").length;
  const trackerCount = tracker.materials.length;

  // Land on Outreach when there are no active leads but there IS tracker history
  // (e.g. a client whose leads have all been drafted/dropped) — otherwise the
  // page would open on an empty "All leads".
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-1">
          {tabBtn("all", "All leads", rows.length)}
          {tabBtn("raw", "Not enriched", rawCount)}
          {tabBtn("marketplace", "Marketplace pricing", marketCount)}
          {tabBtn("outreach", "Outreach", trackerCount)}
        </div>
        <LeadsCsvDownload slug={slug} materials={materials} />
      </div>
      {tab === "all" && (
        <LeadsList rows={rows} canAct={canAct} slug={slug} orgId={orgId} operatorOptions={operatorOptions} />
      )}
      {tab === "raw" && (
        <LeadsList rows={rows} canAct={canAct} slug={slug} orgId={orgId} operatorOptions={operatorOptions} forceStage="raw" />
      )}
      {tab === "marketplace" && <MarketplacePricing rows={rows} canAct={canAct} slug={slug} />}
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
