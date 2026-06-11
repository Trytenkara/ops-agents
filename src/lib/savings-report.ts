import { getClientBenchmark, type ClientBenchmark } from "@/lib/price-pulse";

// Material savings report (#6). For a client, compare what they currently pay
// per material (their current Tenkara quote) against the cheapest current quote
// across all suppliers in the Tenkara corpus (Price Pulse). The gap is the
// savings, and the cheapest supplier is the recommendation.
//
// Read-only on Tenkara: this reads the pulse + the client's own quotes and
// produces a report. Acting on it (re-sourcing) is a human decision.

export interface SavingsLine {
  material_id: string;
  material_name: string;
  unit: string;
  their_unit_price: number;
  best_unit_price: number;
  recommended_supplier_id: string | null;
  recommended_supplier_name: string | null;
  // Per-unit and percentage savings if they switched to the cheapest supplier.
  savings_per_unit: number;
  savings_pct: number;
  market_avg_unit_price: number;
  n_quotes: number;
  n_suppliers: number;
}

export interface SavingsReport {
  tenkara_org_id: string;
  lines: SavingsLine[];
  total_materials: number;
  // How many materials have a cheaper supplier available than what they pay now.
  materials_with_savings: number;
}

function toLine(b: ClientBenchmark): SavingsLine {
  const savings_per_unit = b.client_unit_price - b.min_unit_price;
  const savings_pct =
    b.client_unit_price > 0 ? (savings_per_unit / b.client_unit_price) * 100 : 0;
  return {
    material_id: b.material_id,
    material_name: b.material_name,
    unit: b.unit,
    their_unit_price: b.client_unit_price,
    best_unit_price: b.min_unit_price,
    recommended_supplier_id: b.cheapest_supplier_id,
    recommended_supplier_name: b.cheapest_supplier_name,
    savings_per_unit,
    savings_pct,
    market_avg_unit_price: b.avg_unit_price,
    n_quotes: b.n_quotes,
    n_suppliers: b.n_suppliers,
  };
}

export async function buildSavingsReport(
  tenkaraOrgId: string,
  opts?: { minQuotes?: number; onlyWithSavings?: boolean }
): Promise<SavingsReport> {
  const benchmark = await getClientBenchmark(tenkaraOrgId, { minQuotes: opts?.minQuotes });
  let lines = benchmark.map(toLine);
  const materials_with_savings = lines.filter((l) => l.savings_per_unit > 0).length;
  if (opts?.onlyWithSavings) lines = lines.filter((l) => l.savings_per_unit > 0);
  // Biggest savings opportunity first.
  lines.sort((a, b) => b.savings_per_unit - a.savings_per_unit);
  return {
    tenkara_org_id: tenkaraOrgId,
    lines,
    total_materials: benchmark.length,
    materials_with_savings,
  };
}

// CSV rows for a client-facing savings report. Pairs with lib/csv toCsv().
export const SAVINGS_CSV_HEADERS = [
  "material",
  "unit",
  "their_price_per_unit",
  "best_tenkara_price_per_unit",
  "recommended_supplier",
  "savings_per_unit",
  "savings_pct",
  "market_avg_per_unit",
  "quotes_in_market",
  "suppliers_in_market",
] as const;

export function savingsCsvRows(report: SavingsReport): (string | number)[][] {
  return report.lines.map((l) => [
    l.material_name,
    l.unit,
    round(l.their_unit_price),
    round(l.best_unit_price),
    l.recommended_supplier_name ?? "",
    round(l.savings_per_unit),
    round(l.savings_pct, 1),
    round(l.market_avg_unit_price),
    l.n_quotes,
    l.n_suppliers,
  ]);
}

function round(n: number, places = 4): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}
