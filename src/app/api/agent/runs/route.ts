import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const createRunSchema = z.object({
  org_slug: z.string().optional(),
  status: z.enum(["running", "success", "partial", "failure"]).default("running"),
  summary: z.string().optional(),
  trigger_source: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

const updateRunSchema = z.object({
  run_id: z.string().uuid(),
  status: z.enum(["running", "success", "partial", "failure"]).optional(),
  summary: z.string().optional(),
  errors: z.any().optional(),
  items_processed: z.number().int().optional(),
  token_cost: z.number().optional(),
  finished: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = createRunSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  let org_id: string | null = null;
  if (parsed.data.org_slug) {
    const { data: org } = await admin.from("orgs").select("id").eq("slug", parsed.data.org_slug).maybeSingle();
    org_id = org?.id ?? null;
  }

  const { data, error } = await admin
    .from("agent_runs")
    .insert({
      agent_id: agent.id,
      org_id,
      status: parsed.data.status,
      summary: parsed.data.summary,
      trigger_source: parsed.data.trigger_source,
      metadata: parsed.data.metadata,
    })
    .select("id, run_started_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await admin.from("agents").update({ status: "running", last_run_at: data.run_started_at }).eq("id", agent.id);
  return NextResponse.json({ run_id: data.id, run_started_at: data.run_started_at });
}

export async function PATCH(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = updateRunSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  const patch: any = {};
  if (parsed.data.status) patch.status = parsed.data.status;
  if (parsed.data.summary !== undefined) patch.summary = parsed.data.summary;
  if (parsed.data.errors !== undefined) patch.errors = parsed.data.errors;
  if (parsed.data.items_processed !== undefined) patch.items_processed = parsed.data.items_processed;
  if (parsed.data.token_cost !== undefined) patch.token_cost = parsed.data.token_cost;
  if (parsed.data.finished) patch.run_finished_at = new Date().toISOString();

  const { data, error } = await admin
    .from("agent_runs")
    .update(patch)
    .eq("id", parsed.data.run_id)
    .eq("agent_id", agent.id) // can only update own runs
    .select("id, status")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "run_not_found" }, { status: 404 });

  if (parsed.data.finished) {
    await admin.from("agents").update({ status: "idle" }).eq("id", agent.id);
  }
  return NextResponse.json({ run_id: data.id, status: data.status });
}
