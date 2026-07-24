"use client";

import { useMemo, useState } from "react";
import type { ExpeditedReport } from "@/lib/expedited-report";
import { ExpeditedReportView } from "@/components/expedited-report-view";
import { Button } from "@/components/ui/button";

// Fields the meta-extraction endpoint returns; all optional.
interface MetaPatch {
  run_id?: string;
  run_dates?: string;
  run_duration?: string;
  intro?: string;
  scope?: string;
  prospects_identified?: number;
  suppliers_validated?: number;
  quotes_returned?: number;
  material_notes?: { material: string; note: string }[];
}

// Wraps the expedited report with a prompt box that captures the run metadata the
// DB doesn't carry (run ID/dates, funnel counts, editorial notes). The operator
// types it in plain English; the endpoint extracts structured fields, and we
// overlay them onto the derived report client-side — what you see prints.
export function ExpeditedReportInteractive({
  report,
  slug,
}: {
  report: ExpeditedReport;
  slug: string;
}) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [patch, setPatch] = useState<MetaPatch | null>(null);

  const merged = useMemo<ExpeditedReport>(() => {
    if (!patch) return report;
    const noteByMaterial = new Map((patch.material_notes ?? []).map((n) => [n.material, n.note]));
    const sections = report.sections.map((s) =>
      noteByMaterial.has(s.material_name) ? { ...s, impact_note: noteByMaterial.get(s.material_name)! } : s
    );
    return {
      ...report,
      run_id: patch.run_id ?? report.run_id,
      run_dates: patch.run_dates ?? report.run_dates,
      run_duration: patch.run_duration ?? report.run_duration,
      intro: patch.intro ?? report.intro,
      scope: patch.scope ?? report.scope,
      prospects_identified: patch.prospects_identified ?? report.prospects_identified,
      suppliers_validated: patch.suppliers_validated ?? report.suppliers_validated,
      quotes_returned: patch.quotes_returned ?? report.quotes_returned,
      sections,
    };
  }, [patch, report]);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/savings/expedited-meta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? `Request failed (${res.status})`);
      else setPatch(data as MetaPatch);
    } catch (e: any) {
      setError(e?.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="mx-auto max-w-4xl rounded-xl border p-4 space-y-3 no-print print:hidden">
        <div>
          <div className="text-sm font-medium">Add run details</div>
          <p className="text-xs text-muted-foreground">
            Prices, quotes, and dollar savings come from the data. Type the rest in plain English — run ID and dates,
            how many prospects/suppliers/quotes, an intro line, or a note per material. Nothing is invented.
          </p>
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="e.g. Run TK-0722, ran Jul 19–22 over 72 hrs. 417 prospects, 17 validated, 22 quotes. Note for Oat Groats: domestic, pallet-level MOQ."
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={run} disabled={loading || prompt.trim().length === 0}>
            {loading ? "Applying…" : "Apply to report"}
          </Button>
          {patch && (
            <Button size="sm" variant="ghost" onClick={() => setPatch(null)}>
              Clear run details
            </Button>
          )}
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>
      </div>

      <ExpeditedReportView report={merged} />
    </div>
  );
}
