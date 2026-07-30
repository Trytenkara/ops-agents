"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

// Generic in-page tab switcher. Panels are server-rendered and passed in as
// `content`; all stay mounted (hidden) so switching is instant and each panel
// keeps its own filter state.
export function PanelTabs({
  tabs,
}: {
  tabs: { key: string; label: string; badge?: number; content: React.ReactNode }[];
}) {
  const [active, setActive] = useState(tabs[0]?.key);

  return (
    <div className="space-y-4">
      <div className="flex gap-4 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              active === t.key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {typeof t.badge === "number" && <span className="ml-1.5 text-xs text-muted-foreground">· {t.badge}</span>}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.key} className={active === t.key ? "" : "hidden"}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
