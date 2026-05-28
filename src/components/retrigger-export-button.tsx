"use client";
import { useState, useTransition } from "react";
import { retriggerLeadExport } from "@/app/actions/lead-exports";

export function RetriggerExportButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function onClick() {
    setMsg(null);
    start(async () => {
      const r = await retriggerLeadExport();
      setMsg(r.ok ? "Triggered." : r.error);
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
      >
        {pending ? "Running…" : "Re-trigger Agent 11"}
      </button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}
