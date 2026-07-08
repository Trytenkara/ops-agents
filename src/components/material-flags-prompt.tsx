"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { applyMaterialNameFlag, dismissMaterialNameFlag } from "@/app/actions/material-flags";

export interface MaterialFlag {
  id: string;
  wrong_name: string;
  suggested_name: string;
}

// Prompt shown on the Leads page when Agent 03 flags a misspelled material name.
// Applying renames every lead + draft for the org to the suggested spelling.
export function MaterialFlagsPrompt({ flags }: { flags: MaterialFlag[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const visible = flags.filter((f) => !hidden.has(f.id));
  if (!visible.length) return null;

  function applyFix(id: string) {
    setMsg(null);
    start(async () => {
      const r = await applyMaterialNameFlag(id);
      if (!r.ok) { setMsg(r.error ?? "failed"); return; }
      setHidden((h) => new Set(h).add(id));
      // Regenerate the affected emails with the corrected name.
      if (r.regenerating) {
        fetch("/api/agents/run/agent-04-outreach", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
      }
      const parts = [`Corrected ${r.corrected ?? 0} lead(s)`];
      if (r.superseded) parts.push(`${r.superseded} old draft(s) superseded — delete them in the Tenkara inbox`);
      if (r.regenerating) parts.push(`regenerating ${r.regenerating} email(s) with the correct spelling`);
      setMsg(parts.join(" · ") + ".");
      router.refresh();
    });
  }

  function dismiss(id: string) {
    setMsg(null);
    start(async () => {
      const r = await dismissMaterialNameFlag(id);
      if (!r.ok) { setMsg(r.error ?? "failed"); return; }
      setHidden((h) => new Set(h).add(id));
      setMsg("Dismissed.");
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border border-amber-300/60 bg-amber-500/10 px-4 py-3 space-y-2">
      <div className="text-xs uppercase tracking-wider font-semibold text-amber-800 dark:text-amber-300">
        Possible material misspelling{visible.length > 1 ? "s" : ""}
      </div>
      {visible.map((f) => (
        <div key={f.id} className="flex flex-wrap items-center gap-3 text-sm">
          <span>
            <span className="line-through text-muted-foreground">{f.wrong_name}</span>
            {" → "}
            <span className="font-medium">{f.suggested_name}</span>
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={pending} onClick={() => applyFix(f.id)}>
              Correct all to “{f.suggested_name}”
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => dismiss(f.id)}>
              Name is fine
            </Button>
          </div>
        </div>
      ))}
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  );
}
