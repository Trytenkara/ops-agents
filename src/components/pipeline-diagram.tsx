import { cn } from "@/lib/utils";

// Visual of the outreach pipeline for /how-it-works. Pure presentational.
// The canonical agent list lives in agents-spec.ts; this just sequences the
// happy path and calls out the two human gates (agents stage, humans send).

type StepKind = "agent" | "human";
interface Step {
  kind: StepKind;
  badge: string; // "03" or "YOU"
  title: string;
  detail: string;
}

// 03, 06 and 04 are each scheduled in their own right and hand the lead on by
// stage, not by calling each other. The human gate is Send (nothing leaves
// without a click).
const MAIN_FLOW: Step[] = [
  { kind: "agent", badge: "03", title: "Lead Creator", detail: "Discovers suppliers, stages raw leads" },
  { kind: "agent", badge: "06", title: "Enrichment", detail: "Finds contacts, raw to enriched" },
  { kind: "agent", badge: "04", title: "Outreach", detail: "Drafts one email per supplier" },
  { kind: "agent", badge: "10", title: "QA", detail: "Lints the draft inline, blocks bad ones" },
  { kind: "human", badge: "YOU", title: "Send", detail: "Review & click Send in the Tenkara Inbox" },
  { kind: "agent", badge: "08", title: "Email Scanner", detail: "Reply arrives, drafts the response" },
  { kind: "human", badge: "YOU", title: "Send reply", detail: "Review & send the response" },
];

const SIDE_CHANNELS = [
  { badge: "02", title: "Quote Revalidation", detail: "Daily, drafts re-quotes for expiring quotes" },
  { badge: "05", title: "Marketplace Prices", detail: "Hourly, re-reads listings and updates prices and tiers" },
  { badge: "07", title: "Escalation + Nudge", detail: "Daily, opens cases for stale leads, nudges ops on pending work" },
  { badge: "09", title: "Document Retrieval", detail: "Hourly, collects SDS/CoA/TDS suppliers already publish" },
  { badge: "12", title: "Client Profile", detail: "Hourly, syncs client settings and re-judges leads on a requirements change" },
  { badge: "13", title: "Inbox Context", detail: "Daily, reads thread history so follow-ups strike the right tone" },
  { badge: "14", title: "QA Watchdog", detail: "Daily, integrity sweep posted to Slack" },
  { badge: "15", title: "Reply Manager", detail: "Every 5 min, recovers missed replies and nudges silent threads" },
  { badge: "16", title: "FX Refresh", detail: "Every 6h, restates USD prices when exchange rates move" },
  { badge: "01", title: "Heartbeat", detail: "Confirms the runtime is alive" },
];

export function PipelineDiagram() {
  return (
    <div className="space-y-6">
      <ol className="flex flex-wrap items-stretch gap-y-3">
        {MAIN_FLOW.map((step, i) => (
          <li key={i} className="flex items-stretch">
            <StepCard step={step} />
            {i < MAIN_FLOW.length - 1 && <Arrow />}
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border border-border bg-background" /> Agent (automatic)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm bg-accent" /> Human gate (you click)
        </span>
      </div>

      <div className="rounded-lg border border-border bg-background p-4">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">
          Side-channels (run on their own cadence)
        </div>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SIDE_CHANNELS.map((s) => (
            <li key={s.badge} className="flex items-start gap-2 text-sm">
              <Badge>{s.badge}</Badge>
              <span>
                <span className="font-medium">{s.title}</span>
                <span className="block text-xs text-muted-foreground">{s.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StepCard({ step }: { step: Step }) {
  const isHuman = step.kind === "human";
  return (
    <div
      className={cn(
        "flex w-40 flex-col gap-1 rounded-lg border p-3 shadow-sm",
        isHuman ? "border-transparent bg-accent text-accent-foreground" : "border-border bg-background"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-[11px] font-semibold",
            isHuman ? "bg-accent-foreground/15 text-accent-foreground" : "bg-secondary text-foreground"
          )}
        >
          {step.badge}
        </span>
        <span className="text-sm font-medium leading-tight">{step.title}</span>
      </div>
      <p className={cn("text-xs leading-snug", isHuman ? "text-accent-foreground/80" : "text-muted-foreground")}>
        {step.detail}
      </p>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center px-1.5 text-muted-foreground" aria-hidden="true">
      <svg viewBox="0 0 24 12" className="h-3 w-5">
        <path d="M0 6h20M16 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded bg-secondary px-1 text-[11px] font-semibold text-foreground">
      {children}
    </span>
  );
}
