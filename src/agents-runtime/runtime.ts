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
  // Lane 1 (or undefined) is the primary run and owns the agents.locked_until
  // reservation. Lanes 2..N are extra parallel workers for the same agent.
  lane?: number;
  def: AgentDefinition;
}

function laneLockKey(agentSlug: string, lane: number) {
  return `agent-lane:${agentSlug}:${lane}`;
}

// Step 1: synchronously reserve the agent's lock and open the agent_runs row.
// Returns quickly so the route handler can respond to the user. The actual
// agent body runs in claimRun's caller via runClaimed().
export async function claimRun(opts: {
  agentSlug: string;
  triggerSource: "cron" | "manual" | "webhook";
  input?: Record<string, any>;
  lane?: number;
}): Promise<{ ok: true; claim: RunClaim } | { ok: false; error: string }> {
  const def = getAgentDefinition(opts.agentSlug);
  if (!def) return { ok: false, error: `agent ${opts.agentSlug} not registered in embedded runtime` };
  const lane = opts.lane ?? 1;
  if (lane > 1 && !def.lanes) {
    return { ok: false, error: `agent ${opts.agentSlug} is not lane-parallel (requested lane ${lane})` };
  }
  if (lane > (def.lanes ?? 1)) {
    return { ok: false, error: `agent ${opts.agentSlug} declares ${def.lanes} lanes (requested lane ${lane})` };
  }

  const admin = createAdminClient();
  const now = new Date();
  // Lock TTL must sit just ABOVE the function's maxDuration (800s in api/cron),
  // never below it: a run can legitimately execute for the full maxDuration, and
  // if the lock expired first the dispatcher would start a second, concurrent run.
  // It also must not be huge — on a hard kill the `finally` never runs, so the
  // lock only releases when this TTL expires (the dispatcher skips a locked agent
  // before the orphan-reaper can touch it). 15 min = maxDuration + margin: no
  // double-run, and a killed agent self-heals within ~1 tick after it.
  const LOCK_TTL_MS = 15 * 60 * 1000;
  const lockUntil = new Date(now.getTime() + LOCK_TTL_MS).toISOString();

  // Reap orphans: agent_runs left in `running` past the function timeout were
  // killed by Vercel without finalizing. Mark them failed so the UI is honest.
  // Cutoff must exceed maxDuration too, or we'd flag a still-live long run failed.
  const orphanCutoff = new Date(now.getTime() - LOCK_TTL_MS).toISOString();
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

  // Secondary lanes take a lock on their own lane NUMBER instead of on the agent
  // (lane 1 owns the agent reservation, and the point of a secondary lane is to
  // run alongside it). Two lanes never collide over work because each claims its
  // batch through claim_enrichment_leads (FOR UPDATE SKIP LOCKED); the lane lock
  // exists to stop overlapping dispatcher ticks from stacking a second copy of
  // lane 2 on top of the first.
  if (lane > 1) {
    const { data: got, error: laneLockError } = await admin.rpc("try_runtime_lock", {
      p_key: laneLockKey(opts.agentSlug, lane),
      p_ttl_seconds: Math.floor(LOCK_TTL_MS / 1000),
    });
    if (laneLockError) return { ok: false, error: laneLockError.message };
    if (!got) return { ok: false, error: `lane ${lane} is already running (lane lock held)` };
  }

  const { data: agent, error: lockError } =
    lane === 1
      ? await admin
          .from("agents")
          .update({ locked_until: lockUntil, status: "running" })
          .eq("slug", opts.agentSlug)
          .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
          .select("id, slug, name")
          .maybeSingle()
      : await admin.from("agents").select("id, slug, name").eq("slug", opts.agentSlug).maybeSingle();
  if (lockError || !agent) {
    if (lane > 1) await admin.rpc("release_runtime_lock", { p_key: laneLockKey(opts.agentSlug, lane) });
    if (lockError) return { ok: false, error: lockError.message };
    return { ok: false, error: lane === 1 ? "agent is already running (lock held)" : "agent not found" };
  }

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
    if (lane === 1) {
      await admin.from("agents").update({ locked_until: null, status: "idle" }).eq("id", agent.id);
    } else {
      await admin.rpc("release_runtime_lock", { p_key: laneLockKey(opts.agentSlug, lane) });
    }
    return { ok: false, error: runError?.message ?? "failed to open run" };
  }
  if (lane === 1) {
    await admin.from("agents").update({ current_run_id: run.id }).eq("id", agent.id);
  }

  return {
    ok: true,
    claim: {
      agentId: agent.id,
      agentName: agent.name,
      agentSlug: agent.slug,
      runId: run.id,
      triggerSource: opts.triggerSource,
      input: opts.input,
      lane,
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
  const lane = claim.lane ?? 1;
  let metadata: Record<string, any> = (claim.def.lanes ?? 1) > 1 ? { lane } : {};

  const ctx: RuntimeContext = {
    runId: claim.runId,
    agentId: claim.agentId,
    agentSlug: claim.agentSlug,
    input: { ...(claim.input ?? {}), lane },
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

  await ctx.log(
    (claim.def.lanes ?? 1) > 1 ? `Run started: ${claim.agentName} (lane ${lane})` : `Run started: ${claim.agentName}`,
    { step: "start", data: { trigger: claim.triggerSource, lane } },
  );

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
  // Secondary lanes never took the reservation, so clearing it here would free
  // the agent while lane 1 is still working and let the next tick start a
  // duplicate primary run.
  if (lane === 1) {
    await admin
      .from("agents")
      .update({ locked_until: null, status: "idle", current_run_id: null, last_run_at: new Date().toISOString() })
      .eq("id", claim.agentId);
  } else {
    await admin.rpc("release_runtime_lock", { p_key: laneLockKey(claim.agentSlug, lane) });
  }

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
  lane?: number;
}): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const claimed = await claimRun({
    agentSlug: opts.agentSlug,
    triggerSource: opts.triggerSource,
    input: opts.input,
    lane: opts.lane,
  });
  if (!claimed.ok) return claimed;
  await runClaimed(claimed.claim);
  return { ok: true, runId: claimed.claim.runId };
}
