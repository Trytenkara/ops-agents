import Link from "next/link";
import { cn, relativeTime } from "@/lib/utils";
import type { RunStat } from "@/components/agent-runs-strip";

// Read-only twin of the funnel strip in leads-tabs.tsx: same raw -> enriched ->
// ready-to-send -> held cards, but each links through to the Agent Supplier
// Leads tab instead of switching an in-page tab. Kept as its own component so the
// overview can show the funnel without pulling in the leads page's tab state.
const PIPELINE: { key: StageKey; label: string; agent: string; runLabel: string | null; dot: string }[] = [
  { key: "raw", label: "Raw", agent: "Agent 03 · Discovery", runLabel: "Discovery", dot: "bg-slate-400" },
  { key: "enriched", label: "Enriched", agent: "Agent 06 · Enrichment", runLabel: "Enrichment", dot: "bg-blue-500" },
  { key: "ready", label: "Ready to send", agent: "Agent 04 · Outreach", runLabel: "Outreach", dot: "bg-emerald-500" },
  { key: "held", label: "Held for review", agent: "Needs a human", runLabel: null, dot: "bg-amber-500" },
];

export type StageKey = "raw" | "enriched" | "ready" | "held";

function dotFor(status: string | null | undefined) {
  return status === "failure" ? "bg-destructive" : status === "partial" ? "bg-yellow-500" : "bg-emerald-500";
}

export function SourcingPipelineStrip({
  counts,
  runs = [],
  leadsHref,
}: {
  counts: Record<StageKey, number>;
  runs?: RunStat[];
  leadsHref: string;
}) {
  const runByLabel = new Map(runs.map((r) => [r.label, r]));
  return (
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
          const run = s.runLabel ? runByLabel.get(s.runLabel) : undefined;
          const count = counts[s.key] ?? 0;
          const empty = count === 0;
          return (
            <div key={s.key} className="flex flex-1 items-stretch gap-1.5">
              <Link
                href={leadsHref}
                className={cn(
                  "flex min-w-[9rem] flex-1 flex-col gap-1 rounded-lg border px-3.5 py-2.5 text-left transition-all",
                  "border-border bg-card/50 hover:bg-card hover:shadow-sm",
                  empty && "opacity-55"
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className={cn("inline-block h-2 w-2 rounded-full", empty ? "bg-muted-foreground/30" : s.dot)} />
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
              </Link>
              {i < PIPELINE.length - 1 && (
                <div className="flex items-center px-0.5 text-muted-foreground/40" aria-hidden>
                  →
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
