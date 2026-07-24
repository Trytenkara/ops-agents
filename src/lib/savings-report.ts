import { getClientBenchmark, getMaterialQuotes, type ClientBenchmark, type MarketQuote } from "@/lib/price-pulse";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

// Uploaded POs carry free-text units ("lbs", "units") while the Tenkara quote
// corpus is normalized ("lb", "kg", "g", "l", "oz"). Align the PO side to those
// canonical spellings so order-keyed data (client baseline price, order qty,
// incumbent) actually matches its material's benchmark instead of silently
// dropping. Unknown units pass through lowercased.
const UNIT_ALIASES: Record<string, string> = {
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  kgs: "kg",
  kilogram: "kg",
  kilograms: "kg",
  gram: "g",
  grams: "g",
  ounce: "oz",
  ounces: "oz",
  ozs: "oz",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  ltr: "l",
  gallon: "gal",
  gallons: "gal",
};

export function normalizeUnit(raw: unknown): string {
  const u = (raw ?? "?").toString().trim().toLowerCase() || "?";
  return UNIT_ALIASES[u] ?? u;
}

// Client current cost parsed from uploaded POs, keyed by
// `${tenkara_material_id}|${unit}` (most recent order wins). Feeds the savings
// benchmark as the client baseline when Tenkara has no current_quote. (#5)
export async function clientCostFromOrders(admin: Admin, orgId: string): Promise<Map<string, number>> {
  const { data } = await admin
    .from("client_material_orders")
    .select("tenkara_material_id, unit_price, qty_unit, order_date, created_at")
    .eq("org_id", orgId)
    .not("tenkara_material_id", "is", null)
    .not("unit_price", "is", null)
    .order("order_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  const map = new Map<string, number>();
  for (const o of (data ?? []) as any[]) {
    const price = Number(o.unit_price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const unit = normalizeUnit(o.qty_unit);
    const key = `${o.tenkara_material_id}|${unit}`;
    if (!map.has(key)) map.set(key, price); // rows are newest-first, so first wins
  }
  return map;
}

// Like clientCostFromOrders but carries the incumbent supplier, ordered quantity,
// and unit so the report can show a baseline table + dollar impact. Keyed the
// same way; most-recent order per key wins.
export async function clientOrderDetails(admin: Admin, orgId: string): Promise<Map<string, ClientOrderDetail>> {
  const { data } = await admin
    .from("client_material_orders")
    .select("tenkara_material_id, supplier_name, ordered_qty, unit_price, qty_unit, order_date, created_at")
    .eq("org_id", orgId)
    .not("tenkara_material_id", "is", null)
    .not("unit_price", "is", null)
    .order("order_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  const map = new Map<string, ClientOrderDetail>();
  for (const o of (data ?? []) as any[]) {
    const price = Number(o.unit_price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const unit = normalizeUnit(o.qty_unit);
    const key = `${o.tenkara_material_id}|${unit}`;
    if (map.has(key)) continue; // newest-first, so first wins
    const qty = Number(o.ordered_qty);
    map.set(key, {
      incumbent_name: o.supplier_name ? String(o.supplier_name) : null,
      ordered_qty: Number.isFinite(qty) && qty > 0 ? qty : null,
      qty_unit: unit,
      unit_price: price,
    });
  }
  return map;
}

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
  grade: string | null;
  unit: string;
  their_unit_price: number;
  // false => no client current-supply price; their_unit_price is the market average.
  has_client_price: boolean;
  // "tenkara" (current_quote) | "po" (uploaded PO unit price) | null (market avg).
  client_price_source: "tenkara" | "po" | null;
  best_unit_price: number;
  recommended_supplier_id: string | null;
  recommended_supplier_name: string | null;
  // Per-unit and percentage savings if they switched to the cheapest supplier.
  savings_per_unit: number;
  savings_pct: number;
  market_avg_unit_price: number;
  n_quotes: number;
  n_suppliers: number;
  // The cheapest market quotes for this material/unit (cheapest-first), populated
  // only when buildSavingsReport is called with includeQuotes. Empty otherwise.
  quotes?: MarketQuote[];
}

// Client order facts parsed from uploaded POs, keyed by `${tenkara_material_id}|${unit}`.
// Supplies the incumbent supplier, typical order quantity, and est spend that the
// savings corpus doesn't carry. Most-recent order per key wins.
export interface ClientOrderDetail {
  incumbent_name: string | null;
  ordered_qty: number | null;
  qty_unit: string;
  unit_price: number;
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
    grade: b.grade,
    unit: b.unit,
    their_unit_price: b.client_unit_price,
    has_client_price: b.has_client_price,
    client_price_source: b.client_price_source,
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
  opts?: {
    minQuotes?: number;
    onlyWithSavings?: boolean;
    clientCostFallback?: Map<string, number>;
    // When set, attach the top-N cheapest market quotes to each line (for the
    // expedited report's per-material quote tables).
    includeQuotes?: boolean;
    quotesTopN?: number;
  }
): Promise<SavingsReport> {
  const benchmark = await getClientBenchmark(tenkaraOrgId, {
    minQuotes: opts?.minQuotes,
    clientCostFallback: opts?.clientCostFallback,
  });
  let lines = benchmark.map(toLine);

  if (opts?.includeQuotes) {
    const quotes = await getMaterialQuotes(tenkaraOrgId, { topN: opts?.quotesTopN });
    const byKey = new Map<string, MarketQuote[]>();
    for (const q of quotes) {
      const key = `${q.material_id}|${q.unit}`;
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(q);
    }
    lines = lines.map((l) => ({ ...l, quotes: byKey.get(`${l.material_id}|${l.unit}`) ?? [] }));
  }
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
// Mirrors the on-screen worksheet: client cost and market average are separate
// columns (client cost reads "not provided" when there's no client price), then
// the best Tenkara price + savings. `client_cost_source` records where the
// client cost came from (tenkara current quote vs an uploaded PO).
export const SAVINGS_CSV_HEADERS = [
  "material",
  "grade",
  "unit",
  "client_cost_per_unit",
  "client_cost_source",
  "market_avg_per_unit",
  "best_tenkara_price_per_unit",
  "recommended_supplier",
  "savings_per_unit",
  "savings_pct",
  "quotes_in_market",
  "suppliers_in_market",
] as const;

export function savingsCsvRows(report: SavingsReport): (string | number)[][] {
  return report.lines.map((l) => [
    l.material_name,
    l.grade ?? "",
    l.unit,
    l.has_client_price ? round(l.their_unit_price) : "not provided",
    l.has_client_price ? (l.client_price_source ?? "") : "",
    round(l.market_avg_unit_price),
    round(l.best_unit_price),
    l.recommended_supplier_name ?? "",
    round(l.savings_per_unit),
    round(l.savings_pct, 1),
    l.n_quotes,
    l.n_suppliers,
  ]);
}

function round(n: number, places = 4): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}
