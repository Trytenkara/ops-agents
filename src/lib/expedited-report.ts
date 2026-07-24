import type { SavingsReport } from "@/lib/savings-report";

// View-model for the "Expedited Sourcing Report" (new 5-page client deliverable,
// e.g. the Motherlode TK-0722 template). It is deliberately richer than
// SavingsReport: the layout shows the full funnel, every quote per material,
// order quantities, and dollar impact. Fields the savings model doesn't carry
// yet (order quantities, per-quote MOQ/location, funnel counts, run metadata)
// are OPTIONAL here — the renderer omits or renders "—" for them, and an
// operator can supply them via `meta`. Nothing is ever fabricated.

export interface QuoteRow {
  supplier: string;
  grade?: string | null;
  /** Normalized per-unit price (report standardizes to $/lb). */
  price: number;
  unit: string;
  moq?: string | null;
  location?: string | null;
  /** Reduction vs incumbent, as a percentage (e.g. 26.8). */
  savings_pct: number;
  is_best?: boolean;
  /** Footnote marker for comparable / non-exact grades, e.g. "†". */
  flag?: string | null;
}

export interface MaterialSection {
  material_name: string;
  grade?: string | null;
  incumbent_name?: string | null;
  incumbent_price?: number | null;
  /** e.g. "$3.3709/kg" when the incumbent quoted a different unit. */
  incumbent_unit_note?: string | null;
  unit: string;
  best_savings_pct: number;
  quotes: QuoteRow[];
  /** Free-text line, e.g. "EST. IMPACT AT TYPICAL ORDER: $7,745 saved / order". */
  impact_note?: string | null;
}

export interface BaselineRow {
  material_name: string;
  incumbent_name?: string | null;
  typical_order?: string | null;
  price: number;
  unit: string;
  price_unit_note?: string | null;
  est_spend?: number | null;
}

export interface FindingBar {
  material_name: string;
  savings_pct: number;
  /** Incumbent price; null when there's no client price on file. */
  from: number | null;
  to: number;
  unit: string;
}

export interface ExpeditedReport {
  client_name: string;
  report_date: string;

  run_id?: string | null;
  run_dates?: string | null;
  run_duration?: string | null;
  intro?: string | null;

  materials_priced: number;
  prospects_identified?: number | null;
  suppliers_validated?: number | null;
  quotes_returned?: number | null;

  identified_savings?: number | null;
  baseline_spend?: number | null;
  savings_vs_baseline_pct?: number | null;
  avg_best_quote_reduction_pct: number;

  max_reduction_pct: number;
  max_reduction_material?: string | null;
  max_reduction_from?: number | null;
  max_reduction_to?: number | null;
  materials_beat_incumbent: number;
  materials_total: number;

  findings: FindingBar[];
  baseline: BaselineRow[];
  baseline_total?: number | null;
  sections: MaterialSection[];

  scope?: string | null;
  excludes?: string | null;
}

// Curated fields an operator can layer on top of the derived report. Keyed by
// `${material_id}|${unit}` so per-material additions (extra quotes, order qty,
// incumbent name) line up with the savings model.
export interface ExpeditedMeta {
  run_id?: string;
  run_dates?: string;
  run_duration?: string;
  intro?: string;
  prospects_identified?: number;
  suppliers_validated?: number;
  quotes_returned?: number;
  identified_savings?: number;
  baseline_spend?: number;
  scope?: string;
  excludes?: string;
  materials?: Record<
    string,
    {
      incumbent_name?: string;
      incumbent_unit_note?: string;
      typical_order?: string;
      est_spend?: number;
      impact_note?: string;
      extra_quotes?: QuoteRow[];
    }
  >;
}

function keyOf(l: { material_id: string; unit: string }): string {
  return `${l.material_id}|${l.unit}`;
}

// Maps the savings model into the expedited view-model, filling every real
// number it can and leaving gaps null so the renderer can omit them. `meta`
// supplies the curated run metadata + per-material additions when available.
export function toExpeditedReport(
  report: SavingsReport,
  opts: { clientName: string; reportDate: string; meta?: ExpeditedMeta }
): ExpeditedReport {
  const meta = opts.meta ?? {};
  const lines = report.lines;
  const withSavings = lines.filter((l) => l.savings_per_unit > 0);
  const avg =
    withSavings.length > 0
      ? withSavings.reduce((s, l) => s + l.savings_pct, 0) / withSavings.length
      : 0;
  const top = lines.reduce<(typeof lines)[number] | null>(
    (best, l) => (best == null || l.savings_pct > best.savings_pct ? l : best),
    null
  );

  const findings: FindingBar[] = lines.map((l) => ({
    material_name: l.material_name,
    savings_pct: l.savings_pct,
    from: l.has_client_price ? l.their_unit_price : null,
    to: l.best_unit_price,
    unit: l.unit,
  }));

  const baseline: BaselineRow[] = lines.map((l) => {
    const m = meta.materials?.[keyOf(l)];
    return {
      material_name: l.material_name,
      incumbent_name: m?.incumbent_name ?? null,
      typical_order: m?.typical_order ?? null,
      price: l.their_unit_price,
      unit: l.unit,
      est_spend: m?.est_spend ?? null,
    };
  });

  const savingsVs = (base: number, price: number) => (base > 0 ? ((base - price) / base) * 100 : 0);

  const sections: MaterialSection[] = lines.map((l) => {
    const m = meta.materials?.[keyOf(l)];
    // Prefer the real market quotes attached by buildSavingsReport({ includeQuotes });
    // fall back to the single best row when quotes weren't loaded.
    const fromCorpus: QuoteRow[] =
      l.quotes && l.quotes.length > 0
        ? l.quotes.map((q, i) => ({
            supplier: q.supplier_name ?? "—",
            grade: l.grade,
            price: q.unit_price,
            unit: q.unit,
            moq: q.moq,
            location: q.location,
            savings_pct: savingsVs(l.their_unit_price, q.unit_price),
            is_best: i === 0,
          }))
        : [
            {
              supplier: l.recommended_supplier_name ?? "—",
              grade: l.grade,
              price: l.best_unit_price,
              unit: l.unit,
              savings_pct: l.savings_pct,
              is_best: true,
            },
          ];
    // Operator-supplied additional quotes append after the corpus rows.
    const quotes = [...fromCorpus, ...(m?.extra_quotes ?? [])];
    return {
      material_name: l.material_name,
      grade: l.grade,
      incumbent_name: m?.incumbent_name ?? null,
      incumbent_price: l.has_client_price ? l.their_unit_price : null,
      incumbent_unit_note: m?.incumbent_unit_note ?? null,
      unit: l.unit,
      best_savings_pct: l.savings_pct,
      quotes,
      impact_note: m?.impact_note ?? null,
    };
  });

  const baseline_total =
    meta.baseline_spend ??
    (baseline.every((b) => b.est_spend != null)
      ? baseline.reduce((s, b) => s + (b.est_spend ?? 0), 0)
      : null);

  return {
    client_name: opts.clientName,
    report_date: opts.reportDate,
    run_id: meta.run_id ?? null,
    run_dates: meta.run_dates ?? null,
    run_duration: meta.run_duration ?? null,
    intro: meta.intro ?? null,
    materials_priced: report.total_materials,
    prospects_identified: meta.prospects_identified ?? null,
    suppliers_validated: meta.suppliers_validated ?? null,
    quotes_returned: meta.quotes_returned ?? null,
    identified_savings: meta.identified_savings ?? null,
    baseline_spend: meta.baseline_spend ?? baseline_total,
    savings_vs_baseline_pct:
      meta.identified_savings != null && meta.baseline_spend
        ? (meta.identified_savings / meta.baseline_spend) * 100
        : null,
    avg_best_quote_reduction_pct: avg,
    max_reduction_pct: top?.savings_pct ?? 0,
    max_reduction_material: top?.material_name ?? null,
    max_reduction_from: top?.has_client_price ? top.their_unit_price : null,
    max_reduction_to: top?.best_unit_price ?? null,
    materials_beat_incumbent: report.materials_with_savings,
    materials_total: report.total_materials,
    findings,
    baseline,
    baseline_total,
    sections,
    scope: meta.scope ?? null,
    excludes: meta.excludes ?? "Freight, duties, tariffs, qualification costs",
  };
}
