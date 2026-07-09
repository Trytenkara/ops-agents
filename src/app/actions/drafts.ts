"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";

interface ActionResult {
  ok: boolean;
  error?: string;
}

// Permanently delete draft/thread rows. Drafts are staged locally and nothing
// sends automatically, so this just clears the thread workspace — e.g. when a
// client deletes their email drafts and wants the All Threads tab to match.
// Ops-only; scoped operators can only remove threads for orgs they own.
export async function removeDrafts(
  draftIds: string[]
): Promise<{ ok: boolean; error?: string; removed?: number }> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { ok: false, error: "forbidden" };
  }
  const ids = Array.from(new Set((draftIds ?? []).filter((id) => typeof id === "string" && id)));
  if (ids.length === 0) return { ok: false, error: "no threads selected" };

  const admin = createAdminClient();
  const { data: drafts } = await admin
    .from("draft_references")
    .select("id, org_id")
    .in("id", ids);
  if (!drafts || drafts.length === 0) return { ok: false, error: "no matching threads" };

  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null) {
      const outOfScope = drafts.some((d) => !d.org_id || !assigned.includes(d.org_id));
      if (outOfScope) return { ok: false, error: "forbidden" };
    }
  }

  const found = drafts.map((d) => d.id);
  const { error } = await admin.from("draft_references").delete().in("id", found);
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "drafts.removed",
    target_table: "draft_references",
    target_id: found[0],
    diff: { removed: found.length, ids: found },
  });

  revalidatePath("/work/orgs/[slug]/threads", "page");
  return { ok: true, removed: found.length };
}

export async function markDraftReviewed(draftId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { ok: false, error: "forbidden" };
  }
  const admin = createAdminClient();
  const { data: draft, error } = await admin
    .from("draft_references")
    .update({ status: "reviewed", reviewer: session.userId, reviewed_at: new Date().toISOString() })
    .eq("id", draftId)
    .eq("status", "staged")
    .select("id, agent_id, agent_run_id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!draft) return { ok: false, error: "draft_not_found_or_already_reviewed" };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "draft.mark_reviewed",
    target_table: "draft_references",
    target_id: draftId,
  });

  // Fire SuperAgent webhook so the agent knows it can proceed (no-op if webhook unset).
  await maybeNotifyAgentWebhook(draft.agent_id, {
    event: "draft.reviewed",
    draft_id: draftId,
    agent_run_id: draft.agent_run_id,
    reviewed_by: session.userId,
  });

  return { ok: true };
}

async function maybeNotifyAgentWebhook(agentId: string | null, payload: any) {
  if (!agentId) return;
  const admin = createAdminClient();
  const { data: agent } = await admin.from("agents").select("webhook_url").eq("id", agentId).maybeSingle();
  if (!agent?.webhook_url) return;
  try {
    await fetch(agent.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort. The polling fallback (/api/resolutions) will catch it.
  }
}
