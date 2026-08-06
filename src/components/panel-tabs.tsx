"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// Generic in-page tab switcher. Panels are server-rendered and passed in as
// `content`; all stay mounted (hidden) so switching is instant and each panel
// keeps its own filter state.
//
// `?tab=<key>` opens a specific panel, so a Slack alert can link straight to the
// work it is about. Applied after mount rather than during render: the server has
// no query string to render from, and seeding state from it directly would
// hydrate a different tab than was painted.
export function PanelTabs({
  tabs,
}: {
  tabs: { key: string; label: string; badge?: number; content: React.ReactNode }[];
}) {
  const [active, setActive] = useState(tabs[0]?.key);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    if (requested && tabs.some((t) => t.key === requested)) setActive(requested);
    // Deep link is read once on load; clicking a tab afterwards must win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active === t.key
                ? "bg-card text-foreground shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {typeof t.badge === "number" && <span className="ml-1.5 text-xs text-muted-foreground">{t.badge}</span>}
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
