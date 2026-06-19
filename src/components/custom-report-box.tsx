"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

// Ad-hoc report prompt. Sends the operator's free-form request to Claude (with
// the client's savings data attached server-side) and renders the markdown.
export function CustomReportBox({ slug }: { slug: string }) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    setResult(null);
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
        setResult(data.markdown ?? "");
      }
    } catch (e: any) {
      setError(e?.message ?? "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border p-4 space-y-3 print:hidden">
      <div>
        <div className="text-sm font-medium">Custom report</div>
        <p className="text-xs text-muted-foreground">
          Describe the report you want (e.g. &ldquo;top 5 cheapest suppliers, no savings column&rdquo; or &ldquo;group by grade and
          show only materials with &gt;10% savings&rdquo;). Generated from this client&apos;s savings data.
        </p>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="What should this report show?"
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={run} disabled={loading || prompt.trim().length === 0}>
          {loading ? "Generating…" : "Generate report"}
        </Button>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>
      {result != null && (
        <div className="rounded-md border bg-muted/20 p-4 text-sm whitespace-pre-wrap leading-relaxed">{result}</div>
      )}
    </div>
  );
}
