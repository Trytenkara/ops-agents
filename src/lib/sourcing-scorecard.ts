import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientBenchmark } from "@/lib/price-pulse";

// Live sourcing scorecard (#1 — benchmark at intake). For an active sourcing
// exercise, take the in-flight sourced quotes (staged_quotes, written by the
// reply-loop agents) and score each material's BEST sourced price against the
// client's current price (the benchmark baseline) and the market average.
//
// This is the "are we beating the client-supplied price yet" view. It is
// read-only and retrospective-free: it reflects whatever has been sourced so
// far, updating as new replies land.

export type SourcingStatus = "beating" | "above" | "no_baseline" | "not_comparable";

export interface SourcingScorecardLine {
  material_id: string;
  material_name: string;
  unit: string | null;
  // Best (lowest) per-unit price sourced so far, when comparable.
  best_sourced_unit_price: number | null;
  best_sourced_supplier: string | null;
  // Raw price shown when we can't normalize to per-unit (no case size/unit).
  best_sourced_raw_price: number | null;
  currency: string | null;
  n_sourced: number;
  n_sourced_suppliers: number;
  // Client's current price + market, from the benchmark (null if not benchmarked).
  client_unit_price: number | null;
  market_avg_unit_price: number | null;
  // Positive => best sourced price is below the client's current price.
  beats_client_pct: number | null;
  beats_market: boolean | null;
  status: SourcingStatus;
}

export interface SourcingScorecard {
  lines: SourcingScorecardLine[];
  materials_sourcing: number;
  materials_beating_client: number;
}

function normUnit(u: string | null | undefined): string | null {
  const t = (u ?? "").trim().toLowerCase();
  return t === "" ? null : t;
}

interface StagedQuoteRow {
  material_id: string | null;
  material_name: string | null;
  supplier_name: string | null;
  price: number | null;
  case_size: number | null;
  unit_of_measurement: string | null;
  unit_price: number | null;
  currency: string | null;
}

// `admin` reads staged_quotes (ops Supabase); `tenkaraOrgId` drives the
// benchmark (Tenkara). Pass status to scope which staged quotes count as
// "in flight" — defaults to pending_review.
export async function buildSourcingScorecard(
  admin: SupabaseClient,
  orgId: string,
  tenkaraOrgId: string | null,
  opts?: { statuses?: string[] }
): Promise<SourcingScorecard> {
  const statuses = opts?.statuses ?? ["pending_review"];
  const { data } = await admin
    .from("staged_quotes")
    .select(
      "material_id, material_name, supplier_name, price, case_size, unit_of_measurement, unit_price, currency"
    )
    .eq("org_id", orgId)
    .in("status", statuses)
    .limit(2000);
  const rows = (data ?? []) as StagedQuoteRow[];

  // Benchmark map: client's current price + market avg, keyed by material+unit.
  // When the client has no current-supply price, keep client=null so the line
  // stays "no baseline" and is judged against the market average instead.
  const benchByKey = new Map<string, { client: number | null; avg: number }>();
  if (tenkaraOrgId) {
    const bench = await getClientBenchmark(tenkaraOrgId).catch(() => []);
    for (const b of bench) {
      benchByKey.set(`${b.material_id}|${b.unit}`, {
        client: b.has_client_price ? b.client_unit_price : null,
        avg: b.avg_unit_price,
      });
    }
  }

  // Group staged quotes by material + unit, tracking the best per-unit price.
  interface Group {
    material_id: string;
    material_name: string;
    unit: string | null;
    currency: string | null;
    bestUnit: number | null;
    bestUnitSupplier: string | null;
    bestRaw: number | null;
    suppliers: Set<string>;
    count: number;
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    if (!r.material_id) continue;
    const unit = normUnit(r.unit_of_measurement);
    const key = `${r.material_id}|${unit ?? "?"}`;
    const perUnit =
      r.unit_price != null
        ? Number(r.unit_price)
        : r.price != null && r.case_size != null && Number(r.case_size) > 0
        ? Number(r.price) / Number(r.case_size)
        : null;
    let g = groups.get(key);
    if (!g) {
      g = {
        material_id: r.material_id,
        material_name: r.material_name ?? "—",
        unit,
        currency: r.currency ?? null,
        bestUnit: null,
        bestUnitSupplier: null,
        bestRaw: null,
        suppliers: new Set(),
        count: 0,
      };
      groups.set(key, g);
    }
    g.count++;
    if (r.supplier_name) g.suppliers.add(r.supplier_name);
    if (perUnit != null && (g.bestUnit == null || perUnit < g.bestUnit)) {
      g.bestUnit = perUnit;
      g.bestUnitSupplier = r.supplier_name ?? null;
    }
    if (r.price != null && (g.bestRaw == null || Number(r.price) < g.bestRaw)) {
      g.bestRaw = Number(r.price);
    }
  }

  const lines: SourcingScorecardLine[] = [];
  for (const g of groups.values()) {
    const bench = benchByKey.get(`${g.material_id}|${g.unit}`) ?? null;
    const clientPrice = bench?.client ?? null;
    const marketAvg = bench?.avg ?? null;
    let beatsClientPct: number | null = null;
    let beatsMarket: boolean | null = null;
    let status: SourcingStatus;
    if (g.bestUnit == null) {
      status = "not_comparable";
    } else if (clientPrice == null) {
      status = "no_baseline";
      if (marketAvg != null) beatsMarket = g.bestUnit < marketAvg;
    } else {
      beatsClientPct = clientPrice > 0 ? ((clientPrice - g.bestUnit) / clientPrice) * 100 : null;
      if (marketAvg != null) beatsMarket = g.bestUnit < marketAvg;
      status = g.bestUnit < clientPrice ? "beating" : "above";
    }
    lines.push({
      material_id: g.material_id,
      material_name: g.material_name,
      unit: g.unit,
      best_sourced_unit_price: g.bestUnit,
      best_sourced_supplier: g.bestUnitSupplier,
      best_sourced_raw_price: g.bestRaw,
      currency: g.currency,
      n_sourced: g.count,
      n_sourced_suppliers: g.suppliers.size,
      client_unit_price: clientPrice,
      market_avg_unit_price: marketAvg,
      beats_client_pct: beatsClientPct,
      beats_market: beatsMarket,
      status,
    });
  }

  // Beating first (largest beat %), then no-baseline / above, then not-comparable.
  const rank: Record<SourcingStatus, number> = { beating: 0, no_baseline: 1, above: 2, not_comparable: 3 };
  lines.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    return (b.beats_client_pct ?? -Infinity) - (a.beats_client_pct ?? -Infinity);
  });

  return {
    lines,
    materials_sourcing: lines.length,
    materials_beating_client: lines.filter((l) => l.status === "beating").length,
  };
}
