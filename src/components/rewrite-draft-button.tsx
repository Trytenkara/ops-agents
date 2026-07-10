"use client";
import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { rewriteDraft } from "@/app/actions/rewrite-draft";

// Recompose this staged Tenkara draft with the current material name and upsert
// it in place (overwrites the existing draft in the same conversation).
export function RewriteDraftButton({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="inline-flex items-center gap-2">
      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setErr(null);
            setMsg(null);
            const res = await rewriteDraft(draftId);
            if (!res.ok) setErr(res.error ?? "failed");
            else {
              setMsg(`Rewritten as “${res.materialName}”.`);
              router.refresh();
            }
          })
        }
      >
        {pending ? "Rewriting…" : "Rewrite draft"}
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
