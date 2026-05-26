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

export const maxDuration = 900;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const got = request.headers.get("authorization");
  if (!expected || got !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: agents } = await admin
    .from("agents")
    .select("id, slug, name, schedule_cron, last_run_at, locked_until, runtime")
    .eq("runtime", "embedded")
    .not("schedule_cron", "is", null);

  const triggered: string[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  for (const a of agents ?? []) {
    if (a.locked_until && new Date(a.locked_until) > new Date()) {
      skipped.push({ slug: a.slug, reason: "locked" });
      continue;
    }
    if (!a.schedule_cron) continue;

    let due = false;
    try {
      const last = a.last_run_at ? new Date(a.last_run_at) : new Date(0);
      const interval = CronExpressionParser.parse(a.schedule_cron, { currentDate: last, tz: "America/New_York" });
      const next = interval.next().toDate();
      if (next <= new Date()) due = true;
    } catch (e: any) {
      skipped.push({ slug: a.slug, reason: `bad cron: ${e.message}` });
      continue;
    }
    if (!due) {
      skipped.push({ slug: a.slug, reason: "not yet due" });
      continue;
    }

    // Fire and don't await — multiple agents could be due. Each is concurrency-safe.
    executeAgentRun({ agentSlug: a.slug, triggerSource: "cron" }).catch(() => {});
    triggered.push(a.slug);
  }

  return NextResponse.json({ triggered, skipped, at: new Date().toISOString() });
}
