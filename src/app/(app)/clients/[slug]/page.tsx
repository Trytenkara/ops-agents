import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const LIFECYCLE = [
  "Onboarding",
  "Sourcing",
  "Client ordering",
  "Tenkara PO",
  "Production",
  "Shipping",
  "Receiving & QA",
  "Payment",
  "Reorder",
];
const LIVE_STAGE = "Sourcing";

export default function ClientOverviewPage() {
  return (
    <div className="space-y-6 max-w-5xl">
      {/* Display-only lifecycle strip — tells ops where Control Room fits. No routes. */}
      <div className="rounded-lg border border-border bg-secondary/30 px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Tenkara lifecycle</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {LIFECYCLE.map((stage, i) => (
            <div key={stage} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium",
                  stage === LIVE_STAGE
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground border border-border"
                )}
              >
                {stage}
                {stage === LIVE_STAGE && <span className="ml-1.5 text-[9px] uppercase tracking-wide">live</span>}
              </span>
              {i < LIFECYCLE.length - 1 && <span className="text-muted-foreground/40 text-xs">→</span>}
            </div>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground mt-2">
          Only Sourcing runs in Control Room today. The rest are coming soon as separate modules.
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "Materials sourcing", value: "—" },
          { label: "Active leads", value: "—" },
          { label: "Responses pending", value: "—" },
        ].map((s) => (
          <Card key={s.label} className="tb-surface shadow-none">
            <CardContent className="py-5">
              <div className="text-2xl font-serif">{s.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Sourcing exercises in progress</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Exercise list with status chips, priority items, and the savings headline land here in the next build stage.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
