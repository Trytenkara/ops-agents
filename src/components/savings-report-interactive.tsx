"use client";

import { useMemo, useState } from "react";
import type { SavingsReport } from "@/lib/savings-report";
import { SavingsReportView } from "@/components/savings-report-view";
import { Button } from "@/components/ui/button";

// Wraps the branded savings report with a prompt box that reshapes it. The
// prompt only selects/orders which materials appear (validated server-side);
// the report renders through the same card layout, so what you see is what
// prints.
export function SavingsReportInteractive({
  report,
  clientName,
  slug,
}: {
  report: SavingsReport;
  clientName: string;
  slug: string;
}) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<string[] | null>(null);
  const [subtitle, setSubtitle] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const keyOf = (l: { material_id: string; unit: string }) => `${l.material_id}|${l.unit}`;

  const shaped = useMemo<SavingsReport>(() => {
    if (!keys) return report;
    const byKey = new Map(report.lines.map((l) => [keyOf(l), l]));
    const lines = keys.map((k) => byKey.get(k)).filter((l): l is (typeof report.lines)[number] => Boolean(l));
    return { ...report, lines };
  }, [keys, report]);

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
      </div>

      <SavingsReportView report={shaped} clientName={clientName} subtitle={subtitle} />
    </div>
  );
}
