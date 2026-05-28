"use server";
import { revalidatePath } from "next/cache";
import { getSession, canSeeAgentTab, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateAgentToken } from "@/lib/agent-auth";

export async function setAgentStamp(agentId: string, stamped: boolean) {
  const session = await getSession();
  if (!session || !canSeeAgentTab(session)) return { ok: false, error: "forbidden" } as const;
  const admin = createAdminClient();
  const { error } = await admin.from("agents").update({ stamp_of_approval: stamped }).eq("id", agentId);
  if (error) return { ok: false, error: error.message } as const;
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: stamped ? "agent.stamp_approved" : "agent.stamp_revoked",
    target_table: "agents",
    target_id: agentId,
  });
  return { ok: true } as const;
}

export async function rotateAgentKey(agentId: string) {
  const session = await getSession();
  if (!session || !canSeeAgentTab(session)) return { ok: false, error: "forbidden" } as const;
  const { raw, prefix, hash } = generateAgentToken();
  const admin = createAdminClient();
  const { error } = await admin
    .from("agents")
    .update({ api_key_hash: hash, api_key_prefix: prefix })
    .eq("id", agentId);
  if (error) return { ok: false, error: error.message } as const;
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "agent.key_rotated",
    target_table: "agents",
    target_id: agentId,
    diff: { prefix },
  });
  return { ok: true, token: raw } as const;
}

// Kill switch — flips training_wheels on every non-infrastructure agent.
// Agent 01 (Ping) is kept alive so the heartbeat continues to confirm
// the runtime is reachable even when the fleet is halted.
export async function haltAllAgents() {
  const session = await getSession();
  if (!session || !hasAnyRole(session, ["admin"])) return { ok: false, error: "admin only" } as const;
  const admin = createAdminClient();
  const { error } = await admin
    .from("agents")
    .update({ training_wheels: true })
    .neq("slug", "agent-01-ping");
  if (error) return { ok: false, error: error.message } as const;
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "agents.halt_all",
    target_table: "agents",
    diff: { reason: "kill switch triggered" },
  });
  revalidatePath("/agents/health");
  return { ok: true } as const;
}

export async function resumeAllAgents() {
  const session = await getSession();
  if (!session || !hasAnyRole(session, ["admin"])) return { ok: false, error: "admin only" } as const;
  const admin = createAdminClient();
  const { error } = await admin
    .from("agents")
    .update({ training_wheels: false })
    .neq("slug", "agent-01-ping");
  if (error) return { ok: false, error: error.message } as const;
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "agents.resume_all",
    target_table: "agents",
  });
  revalidatePath("/agents/health");
  return { ok: true } as const;
}
