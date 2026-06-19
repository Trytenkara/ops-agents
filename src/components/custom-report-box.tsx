"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { PrintReportButton } from "@/components/print-report-button";

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
    <div className="space-y-3">
      <div className="rounded-xl border p-4 space-y-3 no-print print:hidden">
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
      </div>

      {result != null && (
        <div className="space-y-3">
          <div className="flex justify-end no-print print:hidden">
            <PrintReportButton target="custom" label="Print / Save PDF" />
          </div>
          <div className="print-custom rounded-xl border bg-background p-6">
            <Markdown content={result} />
          </div>
        </div>
      )}
    </div>
  );
}

function Markdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed space-y-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="font-serif text-2xl tracking-tight">{children}</h1>,
          h2: ({ children }) => <h2 className="font-serif text-xl tracking-tight mt-4">{children}</h2>,
          h3: ({ children }) => <h3 className="font-semibold text-base mt-3">{children}</h3>,
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          hr: () => <hr className="border-border" />,
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/40">{children}</thead>,
          th: ({ children }) => <th className="border border-border px-3 py-1.5 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-border px-3 py-1.5 tabular-nums">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
