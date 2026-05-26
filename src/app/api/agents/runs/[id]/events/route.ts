import { NextResponse, type NextRequest } from "next/server";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Returns events appended to a run since `since_id`. The client polls this
// every ~1s while a run is in progress and stops when the run row reaches
// a terminal status.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!canSeeAgentTab(session)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sinceId = Number(new URL(request.url).searchParams.get("since_id") ?? 0);
  const admin = createAdminClient();

  const [eventsRes, runRes] = await Promise.all([
    admin
      .from("agent_run_events")
      .select("id, at, level, step, message, data")
      .eq("run_id", params.id)
      .gt("id", sinceId)
      .order("id")
      .limit(200),
    admin
      .from("agent_runs")
      .select("id, status, run_started_at, run_finished_at, summary, items_processed")
      .eq("id", params.id)
      .maybeSingle(),
  ]);

  if (runRes.error) return NextResponse.json({ error: runRes.error.message }, { status: 500 });
  if (!runRes.data) return NextResponse.json({ error: "run not found" }, { status: 404 });

  return NextResponse.json({
    run: runRes.data,
    events: eventsRes.data ?? [],
    done: runRes.data.run_finished_at != null,
  });
}
