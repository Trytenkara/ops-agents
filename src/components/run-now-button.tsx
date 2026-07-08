"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface Props {
  agentSlug: string;
  isRunning: boolean;
  currentRunId?: string | null;
  label?: string;
  input?: Record<string, any>;
  // Ops trigger from a client page — they can't see /agents/runs, so stay put
  // and show a success note instead of navigating to the run view.
  stayOnPage?: boolean;
}

export function RunNowButton({ agentSlug, isRunning, currentRunId, label = "Run now", input, stayOnPage = false }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function start() {
    setMsg(null);
    setSubmitting(true);
    const res = await fetch(`/api/agents/run/${agentSlug}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ? { input } : {}),
    });
    const body = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok || !body.ok) {
      setMsg(body.error ?? `HTTP ${res.status}`);
      return;
    }
    if (stayOnPage) {
      setDone(true);
      router.refresh();
      return;
    }
    if (body.run_id) router.push(`/agents/runs/${body.run_id}`);
    else router.refresh();
  }

  if (isRunning && currentRunId) {
    return (
      <Link
        href={`/agents/runs/${currentRunId}`}
        className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground h-8 px-3 text-xs font-medium hover:opacity-90"
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary-foreground animate-pulse mr-1.5" />
        Running — view live
      </Link>
    );
  }

  return (
    <div className="space-y-1">
      <Button size="sm" variant="outline" onClick={start} disabled={submitting || done}>
        {submitting ? "Starting…" : done ? "Started ✓" : label}
      </Button>
      {msg && <p className="text-xs text-destructive">{msg}</p>}
      {done && <p className="text-[11px] text-muted-foreground">Running — check activity above in ~a minute.</p>}
    </div>
  );
}
