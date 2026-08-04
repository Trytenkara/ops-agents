"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

type TabId = "validation" | "marketplace" | "aggregator" | "direct" | "escalations";

export function PriceIndexTabs({
  marketplaceCount,
  aggregatorCount,
  directCount,
  escalationsCount,
  validationCount,
  marketplace,
  aggregator,
  direct,
  escalations,
  validation,
}: {
  marketplaceCount: number;
  aggregatorCount: number;
  directCount: number;
  escalationsCount: number;
  validationCount: number;
  marketplace: React.ReactNode;
  aggregator: React.ReactNode;
  direct: React.ReactNode;
  escalations: React.ReactNode;
  validation: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabId>("validation");

  const Tab = ({ id, label, count }: { id: TabId; label: string; count: number }) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        tab === id
          ? "bg-card text-foreground shadow-sm ring-1 ring-border"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}
      <span className="ml-1.5 text-xs text-muted-foreground">{count}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-1">
        <Tab id="validation" label="Quotes Validation" count={validationCount} />
        <Tab id="marketplace" label="Marketplace prices" count={marketplaceCount} />
        <Tab id="aggregator" label="Aggregator prices" count={aggregatorCount} />
        <Tab id="direct" label="Direct prices" count={directCount} />
        <Tab id="escalations" label="Quotes Escalations" count={escalationsCount} />
      </div>
      <div className={tab === "validation" ? "" : "hidden"}>{validation}</div>
      <div className={tab === "marketplace" ? "" : "hidden"}>{marketplace}</div>
      <div className={tab === "aggregator" ? "" : "hidden"}>{aggregator}</div>
      <div className={tab === "direct" ? "" : "hidden"}>{direct}</div>
      <div className={tab === "escalations" ? "" : "hidden"}>{escalations}</div>
    </div>
  );
}
