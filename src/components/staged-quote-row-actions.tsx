"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  approveStagedQuote,
  dismissStagedQuote,
  reopenStagedQuote,
  updateStagedQuote,
  type StagedQuoteEdit,
} from "@/app/actions/staged-quotes";

interface Props {
  stagedId: string;
  status: "pending_review" | "approved" | "dismissed";
  initial: StagedQuoteEdit;
  disabled?: boolean;
}

export function StagedQuoteRowActions({ stagedId, status, initial, disabled }: Props) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<StagedQuoteEdit>(initial);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setErr(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setErr(res.error ?? "failed");
      else after?.();
    });
  }

  function set<K extends keyof StagedQuoteEdit>(k: K, v: StagedQuoteEdit[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1 items-end">
        <div className="grid grid-cols-2 gap-1">
          <input className="w-28 rounded border border-border bg-background px-1 py-0.5 text-xs" placeholder="supplier"
            value={form.supplier_name ?? ""} onChange={(e) => set("supplier_name", e.target.value)} />
          <input className="w-28 rounded border border-border bg-background px-1 py-0.5 text-xs" placeholder="material"
            value={form.material_name ?? ""} onChange={(e) => set("material_name", e.target.value)} />
          <input className="w-20 rounded border border-border bg-background px-1 py-0.5 text-xs" placeholder="price" inputMode="decimal"
            value={form.price ?? ""} onChange={(e) => set("price", e.target.value === "" ? null : Number(e.target.value))} />
          <input className="w-20 rounded border border-border bg-background px-1 py-0.5 text-xs" placeholder="case size" inputMode="decimal"
            value={form.case_size ?? ""} onChange={(e) => set("case_size", e.target.value === "" ? null : Number(e.target.value))} />
          <input className="w-16 rounded border border-border bg-background px-1 py-0.5 text-xs" placeholder="unit"
            value={form.unit_of_measurement ?? ""} onChange={(e) => set("unit_of_measurement", e.target.value)} />
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="default" disabled={pending} onClick={() => run(() => updateStagedQuote(stagedId, form), () => setEditing(false))}>
            {pending ? "…" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setForm(initial); setEditing(false); }}>
            Cancel
          </Button>
        </div>
        {err && <span className="text-[10px] text-destructive">{err}</span>}
      </div>
    );
  }

  if (status === "pending_review") {
    return (
      <div className="flex gap-1 justify-end items-center">
        <Button size="sm" variant="ghost" disabled={disabled || pending} onClick={() => setEditing(true)}>Edit</Button>
        <Button size="sm" variant="outline" disabled={disabled || pending} onClick={() => run(() => approveStagedQuote(stagedId))}>
          {pending ? "…" : "Approve"}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || pending} onClick={() => run(() => dismissStagedQuote(stagedId))}>Dismiss</Button>
        {err && <span className="text-[10px] text-destructive ml-1">{err}</span>}
      </div>
    );
  }

  return (
    <div className="flex gap-1 justify-end items-center">
      <span className={"text-xs " + (status === "approved" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
        {status}
      </span>
      <Button size="sm" variant="ghost" disabled={disabled || pending} onClick={() => run(() => reopenStagedQuote(stagedId))}>Reopen</Button>
      {err && <span className="text-[10px] text-destructive ml-1">{err}</span>}
    </div>
  );
}
