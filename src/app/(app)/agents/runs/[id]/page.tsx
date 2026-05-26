import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { RunEventStream } from "@/components/run-event-stream";
import { relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RunDetail({ params }: { params: { id: string } }) {
  const session = (await getSession())!;
  if (!canSeeAgentTab(session)) redirect("/");

  const admin = createAdminClient();
  const [runRes, eventsRes] = await Promise.all([
    admin
      .from("agent_runs")
      .select("id, status, run_started_at, run_finished_at, summary, items_processed, agents(name, slug, description)")
      .eq("id", params.id)
      .maybeSingle(),
    admin
      .from("agent_run_events")
      .select("id, at, level, step, message, data")
      .eq("run_id", params.id)
      .order("id")
      .limit(500),
  ]);

  if (!runRes.data) notFound();

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <Link href="/agents" className="text-sm text-muted-foreground hover:underline">← Agent activity</Link>
        <h1 className="font-serif text-3xl tracking-tight mt-2">
          {(runRes.data as any).agents?.name ?? "Run"} <span className="text-muted-foreground text-base">· {relativeTime(runRes.data.run_started_at)}</span>
        </h1>
        {(runRes.data as any).agents?.description && (
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">{(runRes.data as any).agents.description}</p>
        )}
      </div>
      <RunEventStream
        runId={params.id}
        initialEvents={(eventsRes.data ?? []) as any}
        initialRun={runRes.data as any}
      />
    </div>
  );
}
