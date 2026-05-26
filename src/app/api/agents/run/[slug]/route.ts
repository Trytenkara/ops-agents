import { NextResponse, type NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getSession, hasAnyRole } from "@/lib/auth";
import { claimRun, runClaimed } from "@/agents-runtime/runtime";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;

export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasAnyRole(session, ["admin", "monitor"])) {
    return NextResponse.json({ error: "forbidden — Admin or Monitor only" }, { status: 403 });
  }

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

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "agent.run_now",
    target_table: "agents",
    target_id: agent.id,
    diff: { trigger: "manual" },
  });

  const claimed = await claimRun({ agentSlug: params.slug, triggerSource: "manual" });
  if (!claimed.ok) {
    return NextResponse.json({ ok: false, error: claimed.error }, { status: 500 });
  }

  // Schedule the long-running body to run after the response is sent.
  // Vercel keeps the function alive for its maxDuration (300s) to finish
  // waitUntil callbacks, so the agent has the full budget for its work.
  waitUntil(runClaimed(claimed.claim));

  return NextResponse.json({ ok: true, run_id: claimed.claim.runId, status: "running" });
}
