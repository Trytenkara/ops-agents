import { NextResponse, type NextRequest } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { executeAgentRun } from "@/agents-runtime/runtime";
import { createAdminClient } from "@/lib/supabase/admin";

// Triggers a manual run of an embedded agent. Admin/Monitor only.
// Long-running: kicks off the run with waitUntil and immediately returns the run_id
// so the UI can poll for events without blocking on the response.
export const maxDuration = 900; // 15 minutes (Vercel Pro Serverless)

export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasAnyRole(session, ["admin", "monitor"])) {
    return NextResponse.json({ error: "forbidden — Admin or Monitor only" }, { status: 403 });
  }

  // Verify the agent exists and is embedded.
  const admin = createAdminClient();
  const { data: agent } = await admin
    .from("agents")
    .select("id, slug, runtime, locked_until, status")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  if (agent.runtime !== "embedded") {
    return NextResponse.json(
      { error: `agent ${params.slug} runs externally (SuperAgent), not embedded` },
      { status: 400 }
    );
  }
  if (agent.locked_until && new Date(agent.locked_until) > new Date()) {
    return NextResponse.json({ error: "agent is already running" }, { status: 409 });
  }

  // Audit the manual trigger.
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "agent.run_now",
    target_table: "agents",
    target_id: agent.id,
    diff: { trigger: "manual" },
  });

  // Fire and forget — the caller polls /api/agents/runs/[id]/events for live status.
  // We await just long enough to claim the lock + open the run row, then let it run.
  const promise = executeAgentRun({
    agentSlug: params.slug,
    triggerSource: "manual",
    triggeredBy: session.userId,
  });

  // In Node serverless runtime we can't truly fire-and-forget without ctx.waitUntil,
  // but Vercel keeps the function alive until the promise resolves up to maxDuration.
  // For UX we want the request to return ASAP, so we race a short timer.
  const earlyReturn = new Promise<{ ok: false; error: "started" }>((resolve) =>
    setTimeout(() => resolve({ ok: false, error: "started" }), 800)
  );
  const winner = await Promise.race([promise, earlyReturn]);

  // If the run finished within 800ms (unusual), return its real outcome. Otherwise
  // return early — the run continues in the background and polling picks it up.
  if (winner.ok === true) {
    return NextResponse.json({ ok: true, run_id: winner.runId, status: "completed" });
  }
  if (winner.ok === false && winner.error === "started") {
    // Still running — find the run row we just opened so the UI can poll it.
    const { data: run } = await admin
      .from("agent_runs")
      .select("id")
      .eq("agent_id", agent.id)
      .order("run_started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Don't await the original promise — let it complete in the background.
    promise.catch(() => {});
    return NextResponse.json({ ok: true, run_id: run?.id ?? null, status: "running" });
  }
  return NextResponse.json({ ok: false, error: winner.error }, { status: 500 });
}
