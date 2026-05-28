"use client";
import { useTransition, useState } from "react";
import { Button } from "@/components/ui/button";
import { approveFinding, dismissFinding, reopenFinding } from "@/app/actions/marketplace-findings";

interface Props {
  findingId: string;
  status: "pending_review" | "approved" | "dismissed";
  disabled?: boolean;
}

export function MarketplaceFindingActions({ findingId, status, disabled }: Props) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setErr(res.error ?? "failed");
    });
  }

  if (status === "pending_review") {
    return (
      <div className="flex gap-1 justify-end">
        <Button size="sm" variant="outline" disabled={disabled || pending} onClick={() => run(() => approveFinding(findingId))}>
          {pending ? "…" : "Approve"}
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled || pending} onClick={() => run(() => dismissFinding(findingId))}>
          Dismiss
        </Button>
        {err && <span className="text-[10px] text-destructive ml-1">{err}</span>}
      </div>
    );
  }

  return (
    <div className="flex gap-1 justify-end items-center">
      <span className={"text-xs " + (status === "approved" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
        {status === "approved" ? "approved" : "dismissed"}
      </span>
      <Button size="sm" variant="ghost" disabled={disabled || pending} onClick={() => run(() => reopenFinding(findingId))}>
        Reopen
      </Button>
      {err && <span className="text-[10px] text-destructive ml-1">{err}</span>}
    </div>
  );
}
