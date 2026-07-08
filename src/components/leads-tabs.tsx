"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { LeadsList } from "@/components/leads-list";
import { MarketplacePricing } from "@/components/marketplace-pricing";
import { leadMarketKind } from "@/components/lead-rich-row";

// Two views over the same lead set: the full list, and a marketplace-only
// pricing view (suppliers with published website prices, edited into tiers).
export function LeadsTabs({
  rows,
  canAct,
  slug,
  orgId,
  operatorOptions,
}: {
  rows: any[];
  canAct: boolean;
  slug: string;
  orgId?: string;
  operatorOptions?: { id: string; name: string }[];
}) {
  const [tab, setTab] = useState<"all" | "marketplace">("all");

  const marketCount = rows.filter(
    (r) => (r.market_kind ?? leadMarketKind(r.payload?.site_type)) === "marketplace"
  ).length;

  const tabBtn = (key: "all" | "marketplace", label: string, count?: number) => (
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
      <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-1">
        {tabBtn("all", "All leads", rows.length)}
        {tabBtn("marketplace", "Marketplace pricing", marketCount)}
      </div>
      {tab === "all" ? (
        <LeadsList rows={rows} canAct={canAct} slug={slug} orgId={orgId} operatorOptions={operatorOptions} />
      ) : (
        <MarketplacePricing rows={rows} canAct={canAct} slug={slug} />
      )}
    </div>
  );
}
