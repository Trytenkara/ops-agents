"use server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

interface Result { ok: boolean; error?: string }

export async function setOrgDefaultOperators(input: {
  orgId: string;
  primaryUserId: string | null;
  backupUserId: string | null;
}): Promise<Result> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead"])) return { ok: false, error: "forbidden" };

  if (input.primaryUserId && input.primaryUserId === input.backupUserId) {
    return { ok: false, error: "primary and backup can't be the same person" };
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("org_default_operators")
    .select("primary_user_id, backup_user_id")
    .eq("org_id", input.orgId)
    .maybeSingle();

  const { error } = await admin
    .from("org_default_operators")
    .upsert({
      org_id: input.orgId,
      primary_user_id: input.primaryUserId,
      backup_user_id: input.backupUserId,
      updated_at: new Date().toISOString(),
    });
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "org.operators_set",
    target_table: "org_default_operators",
    target_id: null,
    diff: {
      org_id: input.orgId,
      from: existing ?? null,
      to: { primary_user_id: input.primaryUserId, backup_user_id: input.backupUserId },
    },
  });
  return { ok: true };
}
