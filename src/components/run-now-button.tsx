"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface Props {
  agentSlug: string;
  isRunning: boolean;
  currentRunId?: string | null;
}

export function RunNowButton({ agentSlug, isRunning, currentRunId }: Props) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function start() {
    setMsg(null);
    setSubmitting(true);
    const res = await fetch(`/api/agents/run/${agentSlug}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok || !body.ok) {
      setMsg(body.error ?? `HTTP ${res.status}`);
      return;
    }
    // Route to the run-detail view.
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
      <Button size="sm" onClick={start} disabled={submitting}>
        {submitting ? "Starting…" : "Run now"}
      </Button>
      {msg && <p className="text-xs text-destructive">{msg}</p>}
    </div>
  );
}
