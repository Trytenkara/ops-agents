"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

// Two sub-views for the Live Price Index (marketplace re-checks vs direct
// re-quotes). Both are rendered server-side and kept mounted; the toggle just
// shows/hides so switching is instant and each list keeps its filter state.
type TabId = "marketplace" | "direct" | "escalations";

export function PriceIndexTabs({
  marketplaceCount,
  directCount,
  escalationsCount,
  marketplace,
  direct,
  escalations,
}: {
  marketplaceCount: number;
  directCount: number;
  escalationsCount: number;
  marketplace: React.ReactNode;
  direct: React.ReactNode;
  escalations: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabId>("marketplace");

  const Tab = ({ id, label, count }: { id: TabId; label: string; count: number }) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={cn(
        "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
        tab === id
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
    >
      {label} <span className="text-xs text-muted-foreground">· {count}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-4 border-b border-border">
        <Tab id="marketplace" label="Marketplace prices" count={marketplaceCount} />
        <Tab id="direct" label="Direct prices" count={directCount} />
        <Tab id="escalations" label="Quotes Escalations" count={escalationsCount} />
      </div>
      <div className={tab === "marketplace" ? "" : "hidden"}>{marketplace}</div>
      <div className={tab === "direct" ? "" : "hidden"}>{direct}</div>
      <div className={tab === "escalations" ? "" : "hidden"}>{escalations}</div>
    </div>
  );
}
