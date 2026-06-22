"use client";

import { useMemo, useState } from "react";
import type { SavingsReport } from "@/lib/savings-report";
import type { MaterialAttributes } from "@/lib/material-attributes";
import { attrKey } from "@/lib/material-attributes";
import { SavingsReportView } from "@/components/savings-report-view";
import { Button } from "@/components/ui/button";

// Per-unit freight to add to the alternative when computing landed-cost savings.
function freightPerUnit(a: MaterialAttributes | undefined): number {
  if (!a) return 0;
  return (a.freight_ocean ?? 0) + (a.tariff_duty ?? 0);
}

// Wraps the branded savings report with a prompt box that reshapes it. The
// prompt only selects/orders which materials appear (validated server-side);
// the report renders through the same card layout, so what you see is what
// prints.
export function SavingsReportInteractive({
  report,
  clientName,
  slug,
  variant = "savings",
  attributes,
  orgId,
  canEdit = false,
}: {
  report: SavingsReport;
  clientName: string;
  slug: string;
  variant?: "savings" | "freight";
  attributes?: Record<string, MaterialAttributes>;
  orgId?: string;
  canEdit?: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<string[] | null>(null);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [includeFreight, setIncludeFreight] = useState(false);

  const keyOf = (l: { material_id: string; unit: string }) => `${l.material_id}|${l.unit}`;

  // Any material with freight/tariff data entered → the freight toggle is useful.
  const hasFreightData = useMemo(
    () => report.lines.some((l) => freightPerUnit(attributes?.[attrKey(l.material_id, l.unit)]) > 0),
    [report, attributes]
  );

  const shaped = useMemo<SavingsReport>(() => {
    let lines = report.lines;
    // Optionally fold freight into the alternative → landed-cost savings.
    if (includeFreight && attributes) {
      lines = lines.map((l) => {
        const fr = freightPerUnit(attributes[attrKey(l.material_id, l.unit)]);
        if (fr <= 0) return l;
        const best_unit_price = l.best_unit_price + fr;
        const savings_per_unit = l.their_unit_price - best_unit_price;
        const savings_pct = l.their_unit_price > 0 ? (savings_per_unit / l.their_unit_price) * 100 : 0;
        return { ...l, best_unit_price, savings_per_unit, savings_pct };
      });
      lines = [...lines].sort((a, b) => b.savings_per_unit - a.savings_per_unit);
    }
    if (keys) {
      const byKey = new Map(lines.map((l) => [keyOf(l), l]));
      lines = keys.map((k) => byKey.get(k)).filter((l): l is (typeof report.lines)[number] => Boolean(l));
    }
    return { ...report, lines };
  }, [keys, report, includeFreight, attributes]);

  const effectiveSubtitle = subtitle ?? (includeFreight ? "Landed cost — includes freight & tariff" : null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/savings/custom-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Request failed (${res.status})`);
      } else {
        setKeys(Array.isArray(data.keys) ? data.keys : []);
        setSubtitle(typeof data.title === "string" ? data.title : null);
        setNote(typeof data.note === "string" ? data.note : null);
      }
    } catch (e: any) {
      setError(e?.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setKeys(null);
    setSubtitle(null);
    setNote(null);
    setError(null);
  }

  return (
    <div className="space-y-4">
      <div className="mx-auto max-w-3xl rounded-xl border p-4 space-y-3 no-print print:hidden">
        <div>
          <div className="text-sm font-medium">Shape this report</div>
          <p className="text-xs text-muted-foreground">
            Describe what to show (e.g. &ldquo;top 5 cost savings&rdquo;, &ldquo;only materials with &gt;10% savings&rdquo;,
            &ldquo;sort by grade&rdquo;). Filters and reorders the cards below — your numbers, never invented.
          </p>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          placeholder="What should this report show?"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={run} disabled={loading || prompt.trim().length === 0}>
            {loading ? "Applying…" : "Apply to report"}
          </Button>
          {keys && (
            <Button size="sm" variant="ghost" onClick={reset}>
              Reset to full report
            </Button>
          )}
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
          {note && !error && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>
        {hasFreightData && (
          <label className="flex items-center gap-2 border-t pt-3 text-sm">
            <input type="checkbox" checked={includeFreight} onChange={(e) => setIncludeFreight(e.target.checked)} />
            <span>Include freight &amp; tariff (landed-cost savings)</span>
            <span className="text-xs text-muted-foreground">— adds ocean freight + tariff to the Tenkara alternative</span>
          </label>
        )}
      </div>

      <SavingsReportView
        report={shaped}
        clientName={clientName}
        subtitle={effectiveSubtitle}
        variant={variant}
        attributes={attributes}
        orgId={orgId}
        canEdit={canEdit}
      />
    </div>
  );
}
