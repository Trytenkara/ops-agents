import { relativeTime } from "@/lib/utils";

export interface RunStat {
  label: string;
  summary: string | null;
  status: string | null;
  at: string | null;
}

// Compact "what the fleet just did" strip. Runs are fleet-level (not per-org),
// but while the fleet is scoped to one org via ONLY_ORG this reflects that org.
export function AgentRunsStrip({ runs }: { runs: RunStat[] }) {
  if (!runs.length) return null;
  return (
    <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1.5">Recent fleet activity</div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {runs.map((r) => (
          <div key={r.label} className="min-w-[14rem]">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <span
                className={
                  r.status === "failure"
                    ? "inline-block w-1.5 h-1.5 rounded-full bg-destructive"
                    : r.status === "partial"
                      ? "inline-block w-1.5 h-1.5 rounded-full bg-yellow-500"
                      : "inline-block w-1.5 h-1.5 rounded-full bg-emerald-500"
                }
              />
              {r.label}
              <span className="text-muted-foreground font-normal">· {r.at ? relativeTime(r.at) : "never"}</span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{r.summary ?? "—"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
