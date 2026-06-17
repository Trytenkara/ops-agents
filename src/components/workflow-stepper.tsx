"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Sourcing-flow stepper shown on every client tab. Each stage links to the tab
// where that work happens, and the active stage is derived from the current
// route so the highlight follows you as you click through the tabs.
type StageKey = "onboard" | "source" | "quote" | "order" | "export";

const STAGES: { key: StageKey; label: string; href: string; blurb: string }[] = [
  { key: "onboard", label: "Onboard", href: "/profile", blurb: "Client setup, contacts, sourcing config" },
  { key: "source", label: "Source", href: "/leads", blurb: "Discover suppliers, build the drop, send outreach" },
  { key: "quote", label: "Quote", href: "/pipeline", blurb: "Replies & quotes come back for ops review" },
  { key: "order", label: "Order", href: "/materials", blurb: "Track POs, actual vs required, expiry limits" },
  { key: "export", label: "Export", href: "/quotes", blurb: "Finalized quotes & CSV export" },
];

// Which tab route (suffix after the org base) maps to which workflow stage.
// Tabs not listed (Overview, Suppliers, Inbound, Cases, Approvals) sit outside
// the linear flow and leave the stepper neutral.
const SUFFIX_STAGE: { suffix: string; stage: StageKey }[] = [
  { suffix: "/profile", stage: "onboard" },
  { suffix: "/leads", stage: "source" },
  { suffix: "/outreach", stage: "source" },
  { suffix: "/pipeline", stage: "quote" },
  { suffix: "/materials", stage: "order" },
  { suffix: "/revalidation", stage: "order" },
  { suffix: "/quotes", stage: "export" },
  { suffix: "/savings", stage: "export" },
  { suffix: "/price-changes", stage: "export" },
];

export function WorkflowStepper({ base, currentStage }: { base: string; currentStage?: StageKey }) {
  const pathname = usePathname() ?? "";
  const suffix = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  const matched = SUFFIX_STAGE.find((r) => suffix === r.suffix || suffix.startsWith(r.suffix + "/"));
  const activeStage = matched?.stage ?? currentStage;
  const currentIdx = activeStage ? STAGES.findIndex((s) => s.key === activeStage) : -1;
  return (
    <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Sourcing workflow</div>
      <div className="flex flex-wrap items-center gap-1.5">
        {STAGES.map((stage, i) => {
          const state = i < currentIdx ? "done" : i === currentIdx ? "live" : "upcoming";
          return (
            <div key={stage.key} className="flex items-center gap-1.5">
              <Link
                href={`${base}${stage.href}`}
                title={stage.blurb}
                className={cn(
                  "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                  state === "live" && "bg-primary text-primary-foreground",
                  state === "done" && "bg-background text-foreground border border-border hover:bg-secondary",
                  state === "upcoming" && "bg-background text-muted-foreground border border-border hover:text-foreground hover:bg-secondary/60"
                )}
              >
                {state === "done" && <span className="mr-1 text-[10px]">✓</span>}
                {stage.label}
              </Link>
              {i < STAGES.length - 1 && <span className="text-muted-foreground/40 text-xs">→</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
