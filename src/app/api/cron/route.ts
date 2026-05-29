import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { executeAgentRun } from "@/agents-runtime/runtime";
import { CronExpressionParser } from "cron-parser";

// Vercel cron hits this endpoint on a 5-minute interval (see vercel.json).
// We look at every embedded agent with a schedule_cron and run any whose
// scheduled time has elapsed since the last run.
//
// Auth: Vercel sets the Authorization header to `Bearer ${process.env.CRON_SECRET}`
// for cron-triggered requests; manual hits with the same header also work.

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const got = request.headers.get("authorization");
  if (!expected || got !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Ad-hoc single-agent trigger: /api/cron?slug=<agent-slug> runs that agent
  // regardless of schedule. Same CRON_SECRET auth — no new endpoint.
  const explicitSlug = new URL(request.url).searchParams.get("slug");
  if (explicitSlug) {
    const r = await executeAgentRun({ agentSlug: explicitSlug, triggerSource: "manual" });
    return NextResponse.json({ explicit: true, slug: explicitSlug, result: r, at: new Date().toISOString() });
  }

  const { data: agents } = await admin
    .from("agents")
    .select("id, slug, name, schedule_cron, schedule_tz, last_run_at, locked_until, runtime, training_wheels")
    .eq("runtime", "embedded")
    .not("schedule_cron", "is", null);

  const due: string[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  for (const a of agents ?? []) {
    // Kill switch — set training_wheels=true to pause an agent without dropping its cron schedule.
    // Agent 01 ignores this so the heartbeat keeps reporting on a halted fleet.
    if (a.training_wheels && a.slug !== "agent-01-ping") {
      skipped.push({ slug: a.slug, reason: "training_wheels" });
      continue;
    }
    if (a.locked_until && new Date(a.locked_until) > new Date()) {
      skipped.push({ slug: a.slug, reason: "locked" });
      continue;
    }
    if (!a.schedule_cron) continue;

    try {
      const last = a.last_run_at ? new Date(a.last_run_at) : new Date(0);
      const tz = a.schedule_tz ?? "Asia/Manila";
      const interval = CronExpressionParser.parse(a.schedule_cron, { currentDate: last, tz });
      const next = interval.next().toDate();
      if (next <= new Date()) due.push(a.slug);
      else skipped.push({ slug: a.slug, reason: "not yet due" });
    } catch (e: any) {
      skipped.push({ slug: a.slug, reason: `bad cron: ${e.message}` });
    }
  }

  // Dispatch each due agent to its OWN invocation (own 300s budget) instead of
  // running them all fire-and-forget inside this one. A heavy agent (03 scout)
  // can no longer starve/kill the lightweight ones, and if this dispatcher hits
  // its own limit while waiting, each agent's invocation still finishes
  // independently. We await so a quick cron tick reports real outcomes.
  const origin = new URL(request.url).origin;
  const results = await Promise.allSettled(
    due.map((slug) =>
      fetch(`${origin}/api/cron?slug=${encodeURIComponent(slug)}`, {
        headers: { authorization: `Bearer ${expected}` },
      }).then((r) => r.json())
    )
  );
  const triggered = due.map((slug, i) => ({
    slug,
    ok: results[i].status === "fulfilled",
  }));

  return NextResponse.json({ triggered, skipped, at: new Date().toISOString() });
}
