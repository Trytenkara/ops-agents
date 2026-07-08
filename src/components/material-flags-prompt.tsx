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

  function act(id: string, fn: () => Promise<{ ok: boolean; error?: string; corrected?: number }>, okMsg: (n?: number) => string) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) { setMsg(r.error ?? "failed"); return; }
      setHidden((h) => new Set(h).add(id));
      setMsg(okMsg(r.corrected));
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
            <Button
              size="sm"
              disabled={pending}
              onClick={() => act(f.id, () => applyMaterialNameFlag(f.id), (n) => `Corrected ${n ?? 0} lead${n === 1 ? "" : "s"}/drafts.`)}
            >
              Correct all to “{f.suggested_name}”
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => act(f.id, () => dismissMaterialNameFlag(f.id), () => "Dismissed.")}
            >
              Name is fine
            </Button>
          </div>
        </div>
      ))}
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  );
}
