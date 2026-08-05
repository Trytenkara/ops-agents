"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { applyMaterialMergeFlag, dismissMaterialMergeFlag } from "@/app/actions/material-merge-flags";

export interface MaterialMergeFlag {
  id: string;
  keep_name: string;
  keep_grades: string | null;
  drop_name: string;
  drop_grades: string | null;
  reason: string;
  drop_lead_count: number | null;
  shared_supplier_count: number | null;
}

// Prompt shown on the Leads page when Agent 03 finds two material records for
// one substance. Applying folds the duplicate's leads into the survivor.
export function MaterialMergePrompt({ flags }: { flags: MaterialMergeFlag[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const visible = flags.filter((f) => !hidden.has(f.id));
  if (!visible.length) return null;

  function merge(id: string) {
    setMsg(null);
    start(async () => {
      const r = await applyMaterialMergeFlag(id);
      if (!r.ok) { setMsg(r.error ?? "failed"); return; }
      setHidden((h) => new Set(h).add(id));
      if (r.regenerating) {
        fetch("/api/agents/run/agent-04-outreach", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
      }
      const parts = [`Moved ${r.repointed ?? 0} lead(s)`];
      if (r.redundant) parts.push(`dropped ${r.redundant} already sourced under the surviving material`);
      if (r.superseded) parts.push(`${r.superseded} staged draft(s) superseded, delete them in the Tenkara inbox`);
      if (r.regenerating) parts.push(`regenerating ${r.regenerating} email(s)`);
      setMsg(parts.join(" · ") + ".");
      router.refresh();
    });
  }

  function dismiss(id: string) {
    setMsg(null);
    start(async () => {
      const r = await dismissMaterialMergeFlag(id);
      if (!r.ok) { setMsg(r.error ?? "failed"); return; }
      setHidden((h) => new Set(h).add(id));
      setMsg("Dismissed.");
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-sky-300/60 bg-sky-500/10 px-4 py-3 space-y-3">
      <div className="text-xs uppercase tracking-wider font-semibold text-sky-800 dark:text-sky-300">
        Possible duplicate material{visible.length > 1 ? "s" : ""}
      </div>
      {visible.map((f) => (
        <div key={f.id} className="space-y-1 text-sm">
          <div>
            <span className="font-medium">{f.drop_name}</span>
            {f.drop_grades ? <span className="text-muted-foreground"> ({f.drop_grades})</span> : null}
            {" looks like the same material as "}
            <span className="font-medium">{f.keep_name}</span>
            {f.keep_grades ? <span className="text-muted-foreground"> ({f.keep_grades})</span> : null}
            {f.reason === "locant_variant" ? " (the names differ only by a chemical locant)." : "."}
          </div>
          <div className="text-xs text-muted-foreground">
            {f.drop_lead_count ?? 0} lead(s) under the duplicate
            {f.shared_supplier_count
              ? ` · ${f.shared_supplier_count} of its suppliers are already sourced under ${f.keep_name}, so they'd otherwise be emailed twice about one chemical`
              : ""}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" disabled={pending} onClick={() => merge(f.id)}>
              Merge into “{f.keep_name}”
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => dismiss(f.id)}>
              Different materials
            </Button>
          </div>
        </div>
      ))}
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  );
}
