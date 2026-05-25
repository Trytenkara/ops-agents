"use server";
import { getSession, canSeeAgentTab } from "@/lib/auth";
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
