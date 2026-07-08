import { createAdminClient } from "@/lib/supabase/admin";
import { getAgentDefinition, type RuntimeContext, type AgentDefinition } from "./registry";
import { alertErrorEvent, alertRunFinished } from "@/lib/safety-alerts";

// Side-effect import: registers all embedded agents at module load. Must come
// AFTER the registry import so the order is deterministic.
import "./agents";

export { listAgentDefinitions, getAgentDefinition } from "./registry";
export type { AgentDefinition, RuntimeContext } from "./registry";

export interface RunClaim {
  agentId: string;
  agentName: string;
  agentSlug: string;
  runId: string;
  triggerSource: "cron" | "manual" | "webhook";
  input?: Record<string, any>;
  def: AgentDefinition;
}

// Step 1: synchronously reserve the agent's lock and open the agent_runs row.
// Returns quickly so the route handler can respond to the user. The actual
// agent body runs in claimRun's caller via runClaimed().
export async function claimRun(opts: {
  agentSlug: string;
  triggerSource: "cron" | "manual" | "webhook";
  input?: Record<string, any>;
}): Promise<{ ok: true; claim: RunClaim } | { ok: false; error: string }> {
  const def = getAgentDefinition(opts.agentSlug);
  if (!def) return { ok: false, error: `agent ${opts.agentSlug} not registered in embedded runtime` };

  const admin = createAdminClient();
  const now = new Date();
  const lockUntil = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

  // Reap orphans: agent_runs left in `running` past the function timeout were
  // killed by Vercel without finalizing. Mark them failed so the UI is honest.
  const orphanCutoff = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
  await admin
    .from("agent_runs")
    .update({
      status: "failure",
      summary: "function timed out before completion",
      run_finished_at: now.toISOString(),
    })
    .eq("status", "running")
    .lt("run_started_at", orphanCutoff)
    .is("run_finished_at", null);

  const { data: agent, error: lockError } = await admin
    .from("agents")
    .update({ locked_until: lockUntil, status: "running" })
    .eq("slug", opts.agentSlug)
    .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
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

  return {
    ok: true,
    claim: {
      agentId: agent.id,
      agentName: agent.name,
      agentSlug: agent.slug,
      runId: run.id,
      triggerSource: opts.triggerSource,
      input: opts.input,
      def,
    },
  };
}

// Step 2: actually run the agent body. Long-running. Call this from after()
// or any background task — by the time it starts, the user already has the
// run_id and is polling the events endpoint.
export async function runClaimed(claim: RunClaim): Promise<void> {
  const admin = createAdminClient();

  let finalSummary: string | null = null;
  let itemsProcessed = 0;
  let finalStatus: "success" | "partial" | "failure" = "success";
  let metadata: Record<string, any> = {};

  const ctx: RuntimeContext = {
    runId: claim.runId,
    agentId: claim.agentId,
    agentSlug: claim.agentSlug,
    input: claim.input ?? {},
    log: async (message, o) => {
      const level = o?.level ?? "info";
      await admin.from("agent_run_events").insert({
        run_id: claim.runId,
        level,
        step: o?.step ?? null,
        message,
        data: o?.data ?? null,
      });
      if (level === "error") {
        // Debounced inside the alerter; safe to fire on every error event.
        alertErrorEvent({
          agentId: claim.agentId,
          agentSlug: claim.agentSlug,
          agentName: claim.agentName,
          runId: claim.runId,
          message,
          step: o?.step ?? null,
        }).catch((e) => console.error("[safety-alerts] alertErrorEvent failed:", e));
      }
    },
    setSummary: (s) => { finalSummary = s; },
    setItemsProcessed: (n) => { itemsProcessed = n; },
    setStatus: (s) => { finalStatus = s; },
    setMetadata: (patch) => { metadata = { ...metadata, ...patch }; },
  };

  await ctx.log(`Run started — ${claim.agentName}`, { step: "start", data: { trigger: claim.triggerSource } });

  try {
    await claim.def.run(ctx);
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
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    })
    .eq("id", claim.runId);
  await admin
    .from("agents")
    .update({ locked_until: null, status: "idle", current_run_id: null, last_run_at: new Date().toISOString() })
    .eq("id", claim.agentId);

  if (finalStatus !== "success") {
    alertRunFinished({
      agentId: claim.agentId,
      agentSlug: claim.agentSlug,
      agentName: claim.agentName,
      runId: claim.runId,
      status: finalStatus,
      summary: finalSummary,
    }).catch((e) => console.error("[safety-alerts] alertRunFinished failed:", e));
  }
}

// Convenience for callers that want claim+run in one shot (cron, tests).
export async function executeAgentRun(opts: {
  agentSlug: string;
  triggerSource: "cron" | "manual" | "webhook";
  triggeredBy?: string | null;
  input?: Record<string, any>;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const claimed = await claimRun({ agentSlug: opts.agentSlug, triggerSource: opts.triggerSource, input: opts.input });
  if (!claimed.ok) return claimed;
  await runClaimed(claimed.claim);
  return { ok: true, runId: claimed.claim.runId };
}
