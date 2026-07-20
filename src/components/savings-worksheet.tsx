"use client";

import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { SavingsExportCsvButton } from "@/components/savings-export-csv-button";
import { useListFilter, byString, byNumberDesc } from "@/components/use-list-filter";
import type { SavingsReport } from "@/lib/savings-report";
import type { SourcingScorecard, SourcingStatus, SourcingScorecardLine } from "@/lib/sourcing-scorecard";

function money(n: number | null): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function SavingsWorksheet({
  report,
  scorecard,
  slug,
  clientName,
}: {
  report: SavingsReport;
  scorecard: SourcingScorecard;
  slug: string;
  clientName: string;
}) {
  const withSavings = report.lines.filter((l) => l.savings_per_unit > 0);

  const sourcing = useListFilter(scorecard.lines, {
    searchText: (l) => `${l.material_name ?? ""} ${l.best_sourced_supplier ?? ""}`,
    searchPlaceholder: "material or supplier…",
    sorts: [
      { value: "beats", label: "Beats client %", compare: byNumberDesc((l: SourcingScorecardLine) => l.beats_client_pct) },
      { value: "material", label: "Material (A–Z)", compare: byString((l: SourcingScorecardLine) => l.material_name) },
      { value: "client", label: "Client price", compare: byNumberDesc((l: SourcingScorecardLine) => l.client_unit_price) },
    ],
    defaultSort: "beats",
  });

  const bench = useListFilter(report.lines, {
    searchText: (l) => `${l.material_name ?? ""} ${l.grade ?? ""} ${l.recommended_supplier_name ?? ""}`,
    searchPlaceholder: "material, grade, supplier…",
    sorts: [
      { value: "savings_pct", label: "Savings %", compare: byNumberDesc((l) => l.savings_pct) },
      { value: "savings_unit", label: "Savings/unit", compare: byNumberDesc((l) => l.savings_per_unit) },
      { value: "their_price", label: "Their price", compare: byNumberDesc((l) => l.their_unit_price) },
      { value: "material", label: "Material (A–Z)", compare: byString((l) => l.material_name) },
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((l) => l.recommended_supplier_name) },
    ],
    defaultSort: "savings_pct",
  });

  return (
    <div className="space-y-8">
      {scorecard.materials_sourcing > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="font-serif text-xl tracking-tight">Live sourcing</h2>
            <p className="text-sm text-muted-foreground max-w-2xl mt-1">
              Best price sourced so far in the current outreach (quotes staged from supplier replies), scored against what{" "}
              {clientName} pays today. <span className="text-foreground font-medium">Beats client</span> = the best sourced
              per-unit price is below their current price.
            </p>
          </div>

          <div className="flex gap-6 text-sm">
            <div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {scorecard.materials_beating_client}
              </div>
              <div className="text-muted-foreground">materials beating client price</div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums">{scorecard.materials_sourcing}</div>
              <div className="text-muted-foreground">materials being sourced</div>
            </div>
          </div>

          {sourcing.controls}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Client price</TableHead>
                <TableHead className="text-right">Best sourced</TableHead>
                <TableHead className="text-right">vs client</TableHead>
                <TableHead>Best supplier</TableHead>
                <TableHead className="text-right">Sourced</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sourcing.filtered.map((l) => (
                <TableRow key={`${l.material_id}-${l.unit ?? "?"}`}>
                  <TableCell className="font-medium">{l.material_name}</TableCell>
                  <TableCell className="text-muted-foreground">{l.unit ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.client_unit_price)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.best_sourced_unit_price != null
                      ? money(l.best_sourced_unit_price)
                      : l.best_sourced_raw_price != null
                      ? `${money(l.best_sourced_raw_price)} (raw)`
                      : "—"}
                  </TableCell>
                  <TableCell
                    className={
                      "text-right tabular-nums " +
                      (l.beats_client_pct == null
                        ? "text-muted-foreground"
                        : l.beats_client_pct > 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400")
                    }
                  >
                    {l.beats_client_pct == null
                      ? "—"
                      : `${l.beats_client_pct > 0 ? "−" : "+"}${Math.abs(l.beats_client_pct).toFixed(0)}%`}
                  </TableCell>
                  <TableCell className="text-sm">{l.best_sourced_supplier ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {l.n_sourced} / {l.n_sourced_suppliers} sup
                  </TableCell>
                  <TableCell><SourcingStatusBadge status={l.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-muted-foreground max-w-2xl">
            Per-material savings for {clientName}: the price they accepted (approved quote) vs the cheapest current Tenkara
            quote for the same material. Prices are normalized per-unit. Sample quotes and unit-mislabeled outliers are
            excluded. Read-only — acting on a recommendation is a human decision.
          </p>
          <SavingsExportCsvButton slug={slug} disabled={withSavings.length === 0} count={withSavings.length} />
        </div>

        <div className="flex gap-6 text-sm">
          <div>
            <div className="text-2xl font-semibold tabular-nums">{report.materials_with_savings}</div>
            <div className="text-muted-foreground">materials with a cheaper supplier</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums">{report.total_materials}</div>
            <div className="text-muted-foreground">materials benchmarked</div>
          </div>
        </div>

        {bench.controls}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Material</TableHead>
              <TableHead>Grade</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead className="text-right">Client cost</TableHead>
              <TableHead className="text-right">Market avg</TableHead>
              <TableHead className="text-right">Best Tenkara</TableHead>
              <TableHead className="text-right">Savings/unit</TableHead>
              <TableHead className="text-right">%</TableHead>
              <TableHead>Recommended supplier</TableHead>
              <TableHead className="text-right">Quotes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bench.filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                  No approved quotes to benchmark for this client yet.
                </TableCell>
              </TableRow>
            )}
            {bench.filtered.map((l) => {
              const hasSaving = l.savings_per_unit > 0;
              return (
                <TableRow key={`${l.material_id}-${l.unit}`}>
                  <TableCell className="font-medium">{l.material_name}</TableCell>
                  <TableCell className="text-sm">
                    {l.grade ? (
                      <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs">{l.grade}</span>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400 text-xs" title="No grade set on this material in Tenkara.">
                        missing
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{l.unit}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.has_client_price ? (
                      <span title={l.client_price_source === "po" ? "From an uploaded PO unit price" : "From the client's current quote in Tenkara"}>
                        {money(l.their_unit_price)}
                        {l.client_price_source === "po" && <span className="ml-1 text-[10px] text-muted-foreground">from PO</span>}
                      </span>
                    ) : (
                      <span className="text-muted-foreground" title="No client current-supply price on file. Savings are benchmarked against the market average instead.">
                        not provided
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{money(l.market_avg_unit_price)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(l.best_unit_price)}</TableCell>
                  <TableCell className={"text-right tabular-nums " + (hasSaving ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                    {hasSaving ? money(l.savings_per_unit) : "—"}
                  </TableCell>
                  <TableCell className={"text-right tabular-nums " + (hasSaving ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                    {hasSaving ? `${l.savings_pct.toFixed(0)}%` : "—"}
                  </TableCell>
                  <TableCell className="text-sm">{hasSaving ? (l.recommended_supplier_name ?? "—") : "already cheapest"}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{l.n_quotes} / {l.n_suppliers} sup</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

function SourcingStatusBadge({ status }: { status: SourcingStatus }) {
  switch (status) {
    case "beating":
      return (
        <span className="inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
          beats client
        </span>
      );
    case "above":
      return (
        <span className="inline-flex items-center rounded-full bg-red-500/15 text-red-700 dark:text-red-400 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
          above client
        </span>
      );
    case "no_baseline":
      return (
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" title="No benchmarked client price for this material yet.">
          no baseline
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground" title="Sourced quote has no unit/case size, so it can't be normalized per-unit.">
          not comparable
        </span>
      );
  }
}
