import { createAdminClient } from "@/lib/supabase/admin";
import { getAgentDefinition, type RuntimeContext } from "./registry";

// Side-effect import: registers all embedded agents at module load. Must come
// AFTER the registry import so the order is deterministic.
import "./agents";

export { listAgentDefinitions, getAgentDefinition } from "./registry";
export type { AgentDefinition, RuntimeContext } from "./registry";

// Orchestrator: claims a lock on the agent, opens a run, executes the agent,
// closes the run. Concurrency-safe — rejects a second run for the same agent
// while one is in progress (via the locked_until column).
export async function executeAgentRun(opts: {
  agentSlug: string;
  triggerSource: "cron" | "manual" | "webhook";
  triggeredBy?: string | null;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const def = getAgentDefinition(opts.agentSlug);
  if (!def) return { ok: false, error: `agent ${opts.agentSlug} not registered in embedded runtime` };

  const admin = createAdminClient();
  const lockUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const { data: agent, error: lockError } = await admin
    .from("agents")
    .update({ locked_until: lockUntil, status: "running" })
    .eq("slug", opts.agentSlug)
    .or(`locked_until.is.null,locked_until.lt.${new Date().toISOString()}`)
    .select("id, slug, name")
    .maybeSingle();
  if (lockError) return { ok: false, error: lockError.message };
  if (!agent) return { ok: false, error: "agent is already running (lock held)" };

  const { data: run, error: runError } = await admin
    .from("agent_runs")
    .insert({
      agent_id: agent.id,
      status: "running",
      trigger_source: opts.triggerSource,
      summary: null,
    })
    .select("id, run_started_at")
    .single();
  if (runError || !run) {
    await admin.from("agents").update({ locked_until: null, status: "idle" }).eq("id", agent.id);
    return { ok: false, error: runError?.message ?? "failed to open run" };
  }
  await admin.from("agents").update({ current_run_id: run.id }).eq("id", agent.id);

  let finalSummary: string | null = null;
  let itemsProcessed = 0;
  let finalStatus: "success" | "partial" | "failure" = "success";

  const ctx: RuntimeContext = {
    runId: run.id,
    agentId: agent.id,
    agentSlug: agent.slug,
    log: async (message, o) => {
      await admin.from("agent_run_events").insert({
        run_id: run.id,
        level: o?.level ?? "info",
        step: o?.step ?? null,
        message,
        data: o?.data ?? null,
      });
    },
    setSummary: (s) => { finalSummary = s; },
    setItemsProcessed: (n) => { itemsProcessed = n; },
    setStatus: (s) => { finalStatus = s; },
  };

  await ctx.log(`Run started — ${agent.name}`, { step: "start", data: { trigger: opts.triggerSource } });

  try {
    await def.run(ctx);
  } catch (err: any) {
    finalStatus = "failure";
    await ctx.log(`Run crashed: ${err?.message ?? String(err)}`, {
      level: "error",
      step: "crash",
      data: { stack: err?.stack?.slice(0, 4000) ?? null },
    });
  }

  await admin
    .from("agent_runs")
    .update({
      run_finished_at: new Date().toISOString(),
      status: finalStatus,
      summary: finalSummary,
      items_processed: itemsProcessed,
    })
    .eq("id", run.id);
  await admin
    .from("agents")
    .update({ locked_until: null, status: "idle", current_run_id: null, last_run_at: new Date().toISOString() })
    .eq("id", agent.id);

  return { ok: true, runId: run.id };
}
