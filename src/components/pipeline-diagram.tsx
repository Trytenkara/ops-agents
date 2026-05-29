import { cn } from "@/lib/utils";

// Visual of the outreach pipeline for /how-it-works. Pure presentational —
// the canonical agent list lives in agents-spec.ts; this just sequences the
// happy path and calls out the two human gates (agents stage, humans send).

type StepKind = "agent" | "human";
interface Step {
  kind: StepKind;
  badge: string; // "03" or "YOU"
  title: string;
  detail: string;
}

const MAIN_FLOW: Step[] = [
  { kind: "agent", badge: "03", title: "Lead Creator", detail: "New Tenkara material → raw lead" },
  { kind: "agent", badge: "06", title: "Data Enrichment", detail: "Fills detail, raw → enriched" },
  { kind: "human", badge: "YOU", title: "Promote", detail: "On Leads in flight — or Drop it" },
  { kind: "agent", badge: "04", title: "Outreach", detail: "Drafts the email in Missive" },
  { kind: "agent", badge: "10", title: "QA Outreach", detail: "Lints the draft for problems" },
  { kind: "human", badge: "YOU", title: "Send", detail: "Review & click Send in Missive" },
  { kind: "agent", badge: "08", title: "Email Scanner", detail: "Detects the supplier's reply" },
];

const SIDE_CHANNELS = [
  { badge: "02", title: "Quote Revalidation", detail: "Weekly — drafts re-quotes for expiring quotes" },
  { badge: "05", title: "Marketplace Validation", detail: "Daily — flags leads whose catalog match dropped" },
  { badge: "07", title: "Escalation", detail: "Leads idle >14d become a case someone owns" },
  { badge: "11", title: "CSV Push", detail: "Daily — dropped leads handed back to Tenkara eng" },
  { badge: "01", title: "Ping", detail: "Heartbeat — confirms the runtime is alive" },
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
