"use client";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface Event {
  id: number;
  at: string;
  level: "info" | "warn" | "error" | "debug";
  step: string | null;
  message: string;
  data: any | null;
}

interface Run {
  id: string;
  status: "running" | "success" | "partial" | "failure";
  run_started_at: string;
  run_finished_at: string | null;
  summary: string | null;
  items_processed: number;
}

interface Props {
  runId: string;
  initialEvents: Event[];
  initialRun: Run;
}

export function RunEventStream({ runId, initialEvents, initialRun }: Props) {
  const [events, setEvents] = useState<Event[]>(initialEvents);
  const [run, setRun] = useState<Run>(initialRun);
  const lastIdRef = useRef<number>(initialEvents.at(-1)?.id ?? 0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (run.run_finished_at) return; // already done — no need to poll

    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`/api/agents/runs/${runId}/events?since_id=${lastIdRef.current}`);
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        if (body.events?.length) {
          setEvents((prev) => [...prev, ...body.events]);
          lastIdRef.current = body.events[body.events.length - 1].id;
        }
        if (body.run) setRun(body.run);
      } catch {
        // network blip — try again next tick
      }
    }
    const iv = setInterval(tick, 1200);
    tick();
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [runId, run.run_finished_at]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
        {run.run_finished_at == null && <span className="text-xs text-muted-foreground">live</span>}
        {run.summary && <p className="text-sm text-muted-foreground">{run.summary}</p>}
      </div>

      <div className="font-mono text-xs rounded-md border border-border bg-secondary/40 max-h-[60vh] overflow-y-auto">
        {events.length === 0 ? (
          <div className="p-4 text-muted-foreground">Waiting for the first event…</div>
        ) : (
          events.map((e) => (
            <div key={e.id} className="px-3 py-1.5 border-b border-border/40 last:border-0 flex gap-3 items-baseline">
              <span className="text-muted-foreground shrink-0">{new Date(e.at).toISOString().slice(11, 19)}</span>
              {e.step && <span className="text-foreground/70 shrink-0">{e.step}</span>}
              <span className={cn("flex-1", levelColor(e.level))}>{e.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function statusVariant(s: string): any {
  if (s === "success") return "success";
  if (s === "running") return "secondary";
  if (s === "partial") return "warn";
  return "danger";
}
function levelColor(l: string): string {
  if (l === "error") return "text-destructive";
  if (l === "warn") return "text-amber-700 dark:text-amber-400";
  if (l === "debug") return "text-muted-foreground";
  return "";
}
