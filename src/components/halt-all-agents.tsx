"use client";
import { useState, useTransition } from "react";
import { haltAllAgents, resumeAllAgents } from "@/app/actions/agents";

interface Props {
  haltedCount: number;
  totalCount: number;
}

export function HaltAllAgents({ haltedCount, totalCount }: Props) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const allHalted = haltedCount > 0 && haltedCount >= totalCount - 1; // -1 for agent-01-ping

  function onHalt() {
    setErr(null);
    start(async () => {
      const r = await haltAllAgents();
      if (!r.ok) setErr(r.error);
      setConfirming(false);
    });
  }

  function onResume() {
    setErr(null);
    start(async () => {
      const r = await resumeAllAgents();
      if (!r.ok) setErr(r.error);
    });
  }

  if (allHalted) {
    return (
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-destructive/15 text-destructive px-3 py-1 text-xs font-semibold uppercase tracking-wide">
          <span className="w-1.5 h-1.5 rounded-full bg-destructive" />
          Fleet halted — {haltedCount} agents paused
        </span>
        <button
          type="button"
          onClick={onResume}
          disabled={pending}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {pending ? "Resuming…" : "Resume fleet"}
        </button>
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Halt all agents (except Ping)?</span>
        <button
          type="button"
          onClick={onHalt}
          disabled={pending}
          className="rounded-md bg-destructive text-destructive-foreground px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Halting…" : "Yes, halt now"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="rounded-md border border-destructive/40 text-destructive px-3 py-1.5 text-sm font-medium hover:bg-destructive/10"
    >
      Halt all agents
    </button>
  );
}
