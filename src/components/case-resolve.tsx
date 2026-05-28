"use client";
import { useState, useTransition } from "react";
import { resolveCase } from "@/app/actions/cases";

export function CaseResolve({ caseId }: { caseId: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onSubmit() {
    setErr(null);
    start(async () => {
      const r = await resolveCase(caseId, note);
      if (!r.ok) setErr(r.error);
      else setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
      >
        Resolve
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Resolution note (optional)"
        className="border border-border rounded-md px-2 py-1 text-xs w-56"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={pending}
        className="rounded-md bg-primary text-primary-foreground px-2 py-1 text-xs disabled:opacity-50"
      >
        {pending ? "…" : "Done"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        disabled={pending}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        Cancel
      </button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
