"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Batch "rewrite" for selected threads: recompose each staged Tenkara outbound
// RFQ with the current material name and upsert it in place. Ineligible rows
// (sent, non-Tenkara, inbound) are skipped server-side and reported back.
export function BulkRewriteBar({
  count,
  onRewrite,
  onClear,
}: {
  count: number;
  onRewrite: () => Promise<{ ok: boolean; error?: string; rewritten: number; skipped: { id: string; reason: string }[] }>;
  onClear: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (count === 0) return null;
  const plural = count === 1 ? "draft" : "drafts";

  function doRewrite() {
    setErr(null);
    setMsg(null);
    start(async () => {
      const r = await onRewrite();
      if (!r.ok) {
        setErr(r.error ?? "failed");
        return;
      }
      const parts = [`Rewrote ${r.rewritten} ${r.rewritten === 1 ? "draft" : "drafts"}`];
      if (r.skipped.length) parts.push(`skipped ${r.skipped.length} (${r.skipped[0].reason}${r.skipped.length > 1 ? ", …" : ""})`);
      setMsg(parts.join(" · ") + ".");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm">
      <span className="font-medium">{count} {plural} selected</span>
      <Button size="sm" variant="outline" disabled={pending} onClick={doRewrite}>
        {pending ? "Rewriting…" : `Rewrite ${count} ${plural}`}
      </Button>
      <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={onClear}>
        Clear selection
      </button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
