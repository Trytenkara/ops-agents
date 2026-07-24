import type {
  ExpeditedReport,
  FindingBar,
  MaterialSection,
  QuoteRow,
} from "@/lib/expedited-report";
import { PrintReportButton } from "@/components/print-report-button";

// Renders the "Expedited Sourcing Report" — the 5-page client deliverable
// (Motherlode TK-0722 template). Composed of the blocks the design breaks into:
// header, funnel strip, hero savings, KPI cards, findings chart, baseline table,
// per-material quote cards, methodology, and next-steps CTA. HTML-first so it
// prints to PDF through the existing `.print-report` isolation + A4 @page rules.
//
// Aesthetic: mono banners + LCD-style hero numerals, single blue accent, yellow
// hero/CTA panels. Everything is optional-field-safe — gaps render "—" or drop
// out; numbers are only ever those passed in.

function money(n: number | null | undefined, places = 2): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places });
}
function money0(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + Math.round(n).toLocaleString();
}
function pct(n: number | null | undefined, places = 1): string {
  if (n == null) return "—";
  return `${n.toFixed(places)}%`;
}

const BLUE = "#1a3cff";
const HAIR = "border-zinc-300";
const MONO = "font-mono uppercase tracking-[0.18em]";

export function ExpeditedReportView({ report: r }: { report: ExpeditedReport }) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex justify-end no-print print:hidden">
        <PrintReportButton target="report" label="Print / Save PDF" />
      </div>

      <div className="print-report bg-white text-zinc-900 shadow-sm print:shadow-none">
        <Page footer={<Footer r={r} n={1} of={5} />}>
          <Header r={r} />
          <FunnelStrip r={r} />
          <HeroSavings r={r} />
          <KpiCards r={r} />
          <FindingsChart findings={r.findings} />
          <p className="mt-4 text-[10px] leading-relaxed text-zinc-500">
            Savings are quoted-price reductions vs incumbent supplier pricing and exclude freight, duties, tariffs, and
            qualification costs. Dollar figures are estimates from typical order quantities as provided. Prices
            standardized to $/{r.sections[0]?.unit ?? "lb"}; supplier-quoted units shown in parentheses where they
            differ. Where exact specification matches were unavailable, comparable grades are included and flagged for
            technical review before switching.
          </p>
        </Page>

        <Page footer={<Footer r={r} n={2} of={5} />}>
          <BaselineTable r={r} />
          <SectionLabel n="02" title="Tenkara Alternatives · By Material" />
          <div className="space-y-5">
            {r.sections.map((s, i) => (
              <MaterialQuoteCard key={`${s.material_name}-${i}`} s={s} index={i + 1} total={r.sections.length} />
            ))}
          </div>
        </Page>

        <Page footer={<Footer r={r} n={4} of={5} />}>
          <Methodology r={r} />
        </Page>

        <Page footer={<Footer r={r} n={5} of={5} />}>
          <NextSteps r={r} />
        </Page>
      </div>
    </div>
  );
}

// A page-sized region that avoids breaking across a printed page.
function Page({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <section className="report-card flex min-h-[1000px] flex-col px-10 py-9">
      <div className="flex-1">{children}</div>
      {footer}
    </section>
  );
}

function Footer({ r, n, of }: { r: ExpeditedReport; n: number; of: number }) {
  return (
    <div className={`mt-8 flex items-center justify-between border-t ${HAIR} pt-3 text-[9px] text-zinc-500 ${MONO}`}>
      <span>Tenkara · Sourcing Report {r.run_id ?? ""}</span>
      <span>Confidential · Prepared for {r.client_name}</span>
      <span>
        Page {n} / {of}
      </span>
    </div>
  );
}

function Header({ r }: { r: ExpeditedReport }) {
  const banner = ["Expedited Sourcing Report", r.run_id ? `Run ${r.run_id}` : null, r.run_duration ? `${r.run_duration} Pricing Analysis` : null]
    .filter(Boolean)
    .join("  ·  ");
  return (
    <header className={`border-b-2 ${HAIR} pb-5`} style={{ borderColor: BLUE }}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="inline-block h-3 w-3" style={{ backgroundColor: BLUE }} />
          <span className="font-serif text-xl">Tenkara</span>
        </div>
        <div className={`text-right text-[9px] text-zinc-500 ${MONO}`}>{banner}</div>
      </div>
      <div className={`mt-6 text-[9px] text-zinc-500 ${MONO}`}>Prepared For</div>
      <h1 className="mt-1 font-serif text-5xl tracking-tight">{r.client_name}</h1>
      {r.intro ? <p className="mt-3 max-w-2xl text-sm leading-relaxed text-zinc-600">{r.intro}</p> : null}
    </header>
  );
}

function FunnelStrip({ r }: { r: ExpeditedReport }) {
  const cells: [string, string][] = [
    ["Report Date", r.report_date],
    ["Materials Priced", String(r.materials_priced)],
    ["Prospects Identified", r.prospects_identified != null ? String(r.prospects_identified) : "—"],
    ["Suppliers Validated", r.suppliers_validated != null ? String(r.suppliers_validated) : "—"],
    ["Quotes Returned", r.quotes_returned != null ? String(r.quotes_returned) : "—"],
    ["Run Time", r.run_duration ?? "—"],
  ];
  return (
    <div className={`grid grid-cols-3 gap-y-3 border-b ${HAIR} py-4 sm:grid-cols-6`}>
      {cells.map(([label, value]) => (
        <div key={label}>
          <div className={`text-[8px] text-zinc-400 ${MONO}`}>{label}</div>
          <div className="mt-1 text-sm font-semibold tabular-nums">{value}</div>
        </div>
      ))}
    </div>
  );
}

function HeroSavings({ r }: { r: ExpeditedReport }) {
  return (
    <div className="mt-5 flex items-start justify-between gap-6 bg-[#fbf6d9] px-7 py-6" style={{ borderTop: `3px solid ${BLUE}` }}>
      <div>
        <div className={`text-[9px] text-zinc-600 ${MONO}`}>Identified Savings · Per Order Cycle · Est</div>
        <div className="mt-1 font-mono text-6xl font-bold tabular-nums leading-none text-zinc-900">
          {money0(r.identified_savings)}
        </div>
        {r.baseline_spend != null && r.savings_vs_baseline_pct != null ? (
          <div className={`mt-3 text-[9px] text-zinc-600 ${MONO}`}>
            ▼ {pct(r.savings_vs_baseline_pct)} vs current baseline spend of {money0(r.baseline_spend)}
          </div>
        ) : null}
      </div>
      <div className="text-right">
        <div className={`text-[9px] text-zinc-600 ${MONO}`}>
          Best-Quote Reduction,
          <br />
          Avg Across Materials
        </div>
        <div className="mt-1 font-mono text-4xl font-bold tabular-nums text-zinc-900">
          {pct(r.avg_best_quote_reduction_pct)}
        </div>
      </div>
    </div>
  );
}

function KpiCards({ r }: { r: ExpeditedReport }) {
  const cards: { top: string; big: string; sub: string }[] = [
    {
      top: "Max Material Reduction",
      big: pct(r.max_reduction_pct),
      sub: r.max_reduction_material
        ? `${r.max_reduction_material}${r.max_reduction_to != null ? ` · ${money(r.max_reduction_to)}${r.max_reduction_from != null ? ` vs ${money(r.max_reduction_from)}` : ""}/lb` : ""}`
        : "",
    },
    {
      top: "Materials Beat Incumbent",
      big: `${r.materials_beat_incumbent}/${r.materials_total}`,
      sub: r.materials_beat_incumbent === r.materials_total ? "Every material returned a lower quote" : "",
    },
    {
      top: "Qualified Quotes",
      big: r.quotes_returned != null ? String(r.quotes_returned) : "—",
      sub:
        r.prospects_identified != null && r.suppliers_validated != null
          ? `From ${r.prospects_identified} prospective suppliers identified + validated`
          : "",
    },
    {
      top: "Request To Report",
      big: r.run_duration ?? "—",
      sub: "Expedited sourcing run · zero RFQs drafted by your team",
    },
  ];
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <div key={c.top} className={`border ${HAIR} px-4 py-3`} style={{ borderTopColor: BLUE, borderTopWidth: 2 }}>
          <div className={`text-[8px] text-zinc-500 ${MONO}`}>{c.top}</div>
          <div className="mt-1 font-mono text-3xl font-bold tabular-nums">{c.big}</div>
          {c.sub ? <div className={`mt-2 text-[8px] leading-snug text-zinc-500 ${MONO}`}>{c.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

function FindingsChart({ findings }: { findings: FindingBar[] }) {
  const max = Math.max(1, ...findings.map((f) => f.savings_pct));
  return (
    <div className="mt-6">
      <div className={`flex items-center justify-between border-b ${HAIR} pb-2`}>
        <span className={`text-[9px] text-zinc-600 ${MONO}`}>Findings · Best Quote vs Incumbent, By Material</span>
        <span className={`text-[8px] text-zinc-400 ${MONO}`}>▼ = Price Reduction</span>
      </div>
      <div className="mt-3 space-y-2">
        {findings.map((f, i) => (
          <div key={`${f.material_name}-${i}`} className="grid grid-cols-[1.6fr_2.4fr_auto_auto] items-center gap-3 text-xs">
            <div className={`truncate text-[10px] ${MONO}`}>{f.material_name}</div>
            <div className="h-3 bg-zinc-100">
              <div className="h-3" style={{ width: `${(f.savings_pct / max) * 100}%`, backgroundColor: BLUE }} />
            </div>
            <div className="w-14 text-right font-semibold tabular-nums">▼ {pct(f.savings_pct)}</div>
            <div className="w-28 text-right text-[10px] tabular-nums text-zinc-500">
              {f.from != null ? `${money(f.from)} → ${money(f.to)}` : `Best: ${money(f.to)}`} /{f.unit}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ n, title }: { n: string; title: string }) {
  return (
    <div className={`mb-4 mt-8 border-b ${HAIR} pb-2 text-[10px] text-zinc-700 ${MONO}`}>
      {n} · {title}
    </div>
  );
}

function BaselineTable({ r }: { r: ExpeditedReport }) {
  return (
    <>
      <SectionLabel n="01" title="Current Baseline · Incumbent Suppliers" />
      <table className="w-full text-xs">
        <thead>
          <tr className={`border-y ${HAIR} text-left text-[8px] text-zinc-500 ${MONO}`}>
            <th className="py-2 font-medium">Material</th>
            <th className="py-2 font-medium">Incumbent</th>
            <th className="py-2 text-right font-medium">Typical Order</th>
            <th className="py-2 text-right font-medium">Price</th>
            <th className="py-2 text-right font-medium">Est. Spend / Order</th>
          </tr>
        </thead>
        <tbody>
          {r.baseline.map((b, i) => (
            <tr key={`${b.material_name}-${i}`} className={`border-b ${HAIR}`}>
              <td className="py-2.5">{b.material_name}</td>
              <td className="py-2.5 text-zinc-600">{b.incumbent_name ?? "—"}</td>
              <td className="py-2.5 text-right tabular-nums text-zinc-600">{b.typical_order ?? "—"}</td>
              <td className="py-2.5 text-right font-semibold tabular-nums">
                {money(b.price)} <span className="text-zinc-400">/{b.unit}</span>
              </td>
              <td className="py-2.5 text-right font-semibold tabular-nums">{money0(b.est_spend)}</td>
            </tr>
          ))}
        </tbody>
        {r.baseline_total != null ? (
          <tfoot>
            <tr className={`text-[9px] ${MONO}`}>
              <td className="py-2.5" colSpan={4}>
                Total Baseline, Per Order Cycle
              </td>
              <td className="py-2.5 text-right font-bold tabular-nums">{money0(r.baseline_total)}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </>
  );
}

function MaterialQuoteCard({ s, index, total }: { s: MaterialSection; index: number; total: number }) {
  const headerBits = [
    s.grade ? `Grade: ${s.grade}` : null,
    s.incumbent_name ? `Incumbent: ${s.incumbent_name}` : null,
    s.incumbent_price != null
      ? `${money(s.incumbent_price)}/${s.unit}${s.incumbent_unit_note ? ` (${s.incumbent_unit_note})` : ""}`
      : null,
  ].filter(Boolean);
  return (
    <div className={`report-card border ${HAIR}`}>
      <div className="flex items-start justify-between gap-4 px-5 pt-4">
        <div>
          <div className={`text-[8px] text-zinc-400 ${MONO}`}>
            Material {String(index).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </div>
          <h3 className="mt-0.5 font-serif text-2xl">{s.material_name}</h3>
          {headerBits.length ? (
            <div className={`mt-1 text-[8px] text-zinc-500 ${MONO}`}>{headerBits.join(" · ")}</div>
          ) : null}
        </div>
        <div className="text-right">
          <div className={`text-[8px] text-zinc-400 ${MONO}`}>Best Quote</div>
          <div className="font-mono text-3xl font-bold tabular-nums">▼{pct(s.best_savings_pct)}</div>
        </div>
      </div>

      <table className="mt-3 w-full text-xs">
        <thead>
          <tr className={`border-y ${HAIR} bg-zinc-50 text-left text-[8px] text-zinc-500 ${MONO}`}>
            <th className="px-5 py-2 font-medium">Supplier</th>
            <th className="py-2 font-medium">Grade</th>
            <th className="py-2 text-right font-medium">Price</th>
            <th className="py-2 font-medium">MOQ</th>
            <th className="py-2 font-medium">Location</th>
            <th className="px-5 py-2 text-right font-medium">Savings</th>
          </tr>
        </thead>
        <tbody>
          {s.quotes.map((q, i) => (
            <QuoteTr key={`${q.supplier}-${i}`} q={q} />
          ))}
        </tbody>
      </table>

      {s.impact_note ? (
        <div className={`border-t ${HAIR} px-5 py-2.5 text-[9px] text-zinc-600 ${MONO}`}>{s.impact_note}</div>
      ) : null}
    </div>
  );
}

function QuoteTr({ q }: { q: QuoteRow }) {
  return (
    <tr
      className={`border-b ${HAIR} align-top ${q.is_best ? "bg-[#fbf6d9]" : ""}`}
      style={q.is_best ? { borderLeft: `3px solid ${BLUE}` } : undefined}
    >
      <td className="px-5 py-2.5">
        <span>{q.supplier}</span>
        {q.is_best ? (
          <span className="ml-2 inline-block px-1.5 py-0.5 text-[7px] font-bold text-white" style={{ backgroundColor: BLUE }}>
            BEST
          </span>
        ) : null}
      </td>
      <td className="py-2.5 text-zinc-600">
        {q.grade ?? "—"}
        {q.flag ? <sup>{q.flag}</sup> : null}
      </td>
      <td className="py-2.5 text-right font-semibold tabular-nums">
        {money(q.price)} <span className="text-zinc-400">/{q.unit}</span>
      </td>
      <td className="py-2.5 text-zinc-600">{q.moq ?? "—"}</td>
      <td className="py-2.5 text-zinc-600">{q.location ?? "—"}</td>
      <td className="px-5 py-2.5 text-right font-semibold tabular-nums">▼ {pct(q.savings_pct, 2)}</td>
    </tr>
  );
}

function Methodology({ r }: { r: ExpeditedReport }) {
  const specs: [string, string][] = [
    ["Scope", r.scope ?? `${r.materials_priced} materials, as supplied by ${r.client_name}`],
    [
      "Funnel",
      [r.prospects_identified != null ? `${r.prospects_identified} identified` : null, r.suppliers_validated != null ? `${r.suppliers_validated} validated` : null, r.quotes_returned != null ? `${r.quotes_returned} quotes` : null]
        .filter(Boolean)
        .join(" · ") || "—",
    ],
    ["Evaluated On", "Price · MOQ · specification"],
    ["Excludes", r.excludes ?? "Freight, duties, tariffs, qualification costs"],
    ["Quote Basis", "Supplier-quoted material pricing"],
    ["Dollar Figures", "Estimated at typical order quantities"],
  ];
  return (
    <>
      <div className={`mb-4 flex items-center justify-between border-b ${HAIR} pb-2 text-[10px] text-zinc-700 ${MONO}`}>
        <span>03 · Methodology</span>
        {r.run_id || r.run_dates ? <span className="text-zinc-400">{[r.run_id, r.run_dates].filter(Boolean).join(" · ")}</span> : null}
      </div>
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
        <div className="space-y-4 text-sm leading-relaxed text-zinc-700">
          <p>
            Tenkara ran an expedited sourcing report across all {r.materials_priced} materials in parallel
            {r.prospects_identified != null && r.suppliers_validated != null && r.quotes_returned != null
              ? `. The platform identified ${r.prospects_identified} prospective suppliers, validated ${r.suppliers_validated}, and collected ${r.quotes_returned} qualified quotes`
              : ""}
            , normalizing every response on price, minimum order quantity, and product specification. Weeks of manual
            RFQ work, compressed into a single automated run with zero effort from the {r.client_name} team.
          </p>
          <p>
            Where an exact specification match was unavailable, the closest comparable grade is included and flagged.
            Comparable grades should complete technical review before any switch. Sourcing is one workflow: Tenkara
            embeds AI workflows across manufacturing operations, and an expedited report like this one is the entry
            point.
          </p>
        </div>
        <dl className="space-y-3">
          {specs.map(([k, v]) => (
            <div key={k} className={`grid grid-cols-[110px_1fr] gap-3 border-b ${HAIR} pb-3`}>
              <dt className={`text-[8px] text-zinc-400 ${MONO}`}>{k}</dt>
              <dd className="text-xs text-zinc-700">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

function NextSteps({ r }: { r: ExpeditedReport }) {
  const steps = [
    ["Schedule A Call", "Review findings live with Tenkara and quantify impact across the business."],
    ["Scope Implementation", "Map where Tenkara embeds alongside the rest of your software stack."],
    ["Contract + Go Live", "Contract and go live. Savings begin on the first PO."],
  ];
  return (
    <>
      <div className={`mb-4 border-b ${HAIR} pb-2 text-[10px] text-zinc-700 ${MONO}`}>04 · Recommended Next Steps</div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {steps.map(([title, body], i) => (
          <div key={title} className={`border ${HAIR} px-5 py-4`}>
            <div className="font-mono text-2xl font-bold text-zinc-300">{String(i + 1).padStart(2, "0")}</div>
            <div className={`mt-2 text-[9px] text-zinc-700 ${MONO}`}>{title}</div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-600">{body}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex items-center justify-between gap-6 bg-[#fbf6d9] px-8 py-7" style={{ borderTop: `3px solid ${BLUE}` }}>
        <div className="max-w-md">
          <h2 className="font-serif text-2xl leading-snug">
            Sourcing was the start.
            <br />
            <span className="italic">Tenkara embeds AI across your operation.</span>
          </h2>
          <p className="mt-3 text-xs leading-relaxed text-zinc-600">
            This expedited report is one workflow. Tenkara is software that embeds AI workflows across sourcing,
            procurement, and operations, inside the tools your team already runs.
          </p>
        </div>
        <div className="text-right">
          <div className={`text-[8px] text-zinc-600 ${MONO}`}>Avg Best-Quote Reduction</div>
          <div className="font-mono text-4xl font-bold tabular-nums">▼{pct(r.avg_best_quote_reduction_pct)}</div>
          <div className="mt-3 inline-block bg-zinc-900 px-4 py-2 text-[9px] font-bold text-white uppercase tracking-[0.18em]">
            Sign Up Today
          </div>
        </div>
      </div>

      <p className="mt-4 text-[9px] leading-relaxed text-zinc-500">
        Prepared by Tenkara · Embedded AI workflows for manufacturers.
        {r.run_dates ? ` All quotes collected ${r.run_dates} and subject to supplier confirmation.` : " Quotes subject to supplier confirmation."}{" "}
        This document is confidential and prepared for {r.client_name}.
      </p>
    </>
  );
}
