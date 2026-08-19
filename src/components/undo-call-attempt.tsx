"use client";

import { useState, useTransition } from "react";
import { undoLastCallAttempt } from "@/app/actions/cases";

// Takes back the last outcome logged on a call task. Shown wherever a logged
// outcome is displayed, including on closed tasks, because a terminal outcome
// closes the task and the operator who misclicked has nowhere else to go.
export function UndoCallAttempt({ caseId, label = "Undo last outcome" }: { caseId: string; label?: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setErr(null);
          start(async () => {
            const r = await undoLastCallAttempt(caseId);
            if (!r.ok) setErr(r.error);
          });
        }}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
      >
        {pending ? "Undoing..." : label}
      </button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}
