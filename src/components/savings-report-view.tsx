import type { SavingsReport } from "@/lib/savings-report";
import { PrintReportButton } from "@/components/print-report-button";

// Branded, client-facing Savings Report (ops template v2 — "Cost Savings" type).
// Mirrors the B&R / NutriScience Canva layout: per-material card with the
// client's current source vs the cheapest Tenkara alternative, plus an
// average-savings summary. Fields we don't have yet (MOQ, freight, tariff,
// facility certs) are omitted gracefully — the freight-split "Within Target"
// variant needs data the corpus doesn't carry today.

function money(n: number | null | undefined, places = 2): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places });
}

function todayLabel(): string {
  return new Date().toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SavingsReportView({
  report,
  clientName,
  subtitle,
}: {
  report: SavingsReport;
  clientName: string;
  subtitle?: string | null;
}) {
  const lines = report.lines;
  const withSavings = lines.filter((l) => l.savings_per_unit > 0);
  const avgSavingsPct =
    withSavings.length > 0
      ? withSavings.reduce((s, l) => s + l.savings_pct, 0) / withSavings.length
      : 0;

  return (
    <div className="print-report mx-auto max-w-3xl space-y-6">
      <div className="flex justify-end no-print print:hidden">
        <PrintReportButton target="report" />
      </div>

      {/* Header */}
      <div className="rounded-xl border bg-muted/30 px-8 py-7">
        <div className="flex items-center gap-2 text-sm font-medium">
          <img src="/tenkara-mark.png" alt="Tenkara" className="h-5 w-5" />
          <span>Tenkara</span>
        </div>
        <h1 className="mt-5 font-serif text-4xl tracking-tight">{clientName}</h1>
        {subtitle ? <p className="mt-1 text-sm font-medium">{subtitle}</p> : null}
        <p className="mt-2 text-xs text-muted-foreground">Savings Report · {todayLabel()}</p>
      </div>

      {lines.length === 0 && (
        <p className="text-center text-sm text-muted-foreground py-12">
          No benchmarked materials to report for this client yet.
        </p>
      )}

      {/* Per-material cards */}
      <div className="space-y-5">
        {lines.map((l) => {
          const hasSaving = l.savings_per_unit > 0;
          return (
            <div key={`${l.material_id}-${l.unit}`} className="rounded-xl border overflow-hidden">
              <div className="flex items-center justify-between gap-4 bg-muted/40 px-5 py-3">
                <div className="font-semibold">
                  {l.material_name}
                  {l.grade ? <span className="font-normal italic text-muted-foreground"> — {l.grade}</span> : null}
                </div>
                <span className="shrink-0 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  {hasSaving ? `${l.savings_pct.toFixed(2)}% Savings` : "Within Target Range"}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2">
                <div className="bg-background px-5 py-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Your current source
                  </div>
                  <div className="mt-2 text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">
                    {money(l.their_unit_price)}
                    <span className="text-sm font-normal text-muted-foreground">/{l.unit}</span>
                  </div>
                </div>
                <div className="border-l-2 border-emerald-500/40 bg-background px-5 py-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                    Tenkara alternative
                  </div>
                  <div className="mt-1 font-medium">{l.recommended_supplier_name ?? "—"}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {money(l.best_unit_price)}
                    <span className="text-sm font-normal text-muted-foreground">/{l.unit}</span>
                  </div>
                </div>
              </div>

              <div className="border-t bg-muted/20 px-5 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Market:</span> avg {money(l.market_avg_unit_price)}/{l.unit} ·{" "}
                {l.n_quotes} quotes from {l.n_suppliers} suppliers
              </div>
            </div>
          );
        })}
      </div>

      {/* Summary footer */}
      {lines.length > 0 && (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border">
          <div className="bg-muted/30 px-6 py-5">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Average savings</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {avgSavingsPct.toFixed(2)}%
            </div>
          </div>
          <div className="bg-muted/30 px-6 py-5 text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Ingredients analyzed</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{lines.length}</div>
          </div>
        </div>
      )}
    </div>
  );
}
