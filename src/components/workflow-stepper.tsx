"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

// Sourcing-flow stepper shown on every client tab. Each stage links to the tab
// where that work happens, so the nav itself communicates the workflow order.
// currentStage is a prop for now (static "source" — only Sourcing runs in
// Control Room today). Deriving real per-client stage is a follow-up.
type StageKey = "onboard" | "source" | "quote" | "order" | "export";

const STAGES: { key: StageKey; label: string; href: string; blurb: string }[] = [
  { key: "onboard", label: "Onboard", href: "/settings", blurb: "Client setup, contacts, sourcing config" },
  { key: "source", label: "Source", href: "/work", blurb: "Discover suppliers, build the drop, send outreach" },
  { key: "quote", label: "Quote", href: "/queue", blurb: "Replies & quotes come back for ops review" },
  { key: "order", label: "Order", href: "/materials", blurb: "Track POs, actual vs required, expiry limits" },
  { key: "export", label: "Export", href: "/documents", blurb: "Export the CSV and keep order records" },
];

export function WorkflowStepper({ base, currentStage = "source" }: { base: string; currentStage?: StageKey }) {
  const currentIdx = STAGES.findIndex((s) => s.key === currentStage);
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
                {state === "live" && <span className="ml-1.5 text-[9px] uppercase tracking-wide">live</span>}
              </Link>
              {i < STAGES.length - 1 && <span className="text-muted-foreground/40 text-xs">→</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
