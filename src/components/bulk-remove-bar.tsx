"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

// Sticky action bar shown when rows are selected for hard deletion. Requires a
// two-step confirm since removal is permanent (see removeLeads / removeDrafts).
export function BulkRemoveBar({
  count,
  noun,
  onRemove,
  onClear,
}: {
  count: number;
  noun: string;
  onRemove: () => Promise<{ ok: boolean; error?: string; removed?: number }>;
  onClear: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (count === 0) return null;
  const plural = count === 1 ? noun : `${noun}s`;

  function doRemove() {
    setErr(null);
    start(async () => {
      const r = await onRemove();
      if (!r.ok) {
        setErr(r.error ?? "failed");
        return;
      }
      setConfirming(false);
      onClear();
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <span className="font-medium">
        {count} {plural} selected
      </span>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Permanently delete — this can&apos;t be undone.</span>
          <Button size="sm" variant="destructive" disabled={pending} onClick={doRemove}>
            {pending ? "Deleting…" : `Delete ${count} ${plural}`}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setConfirming(false); setErr(null); }}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
            Remove selected
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground underline hover:text-foreground"
            onClick={onClear}
          >
            Clear selection
          </button>
        </>
      )}
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
