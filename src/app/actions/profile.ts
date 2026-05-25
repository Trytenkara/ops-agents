"use server";
import { getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function setOwnStatus(status: "active" | "out_of_office") {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" } as const;
  const admin = createAdminClient();
  const { error } = await admin.from("users").update({ status }).eq("id", session.userId);
  if (error) return { ok: false, error: error.message } as const;
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "user.status_change",
    target_table: "users",
    target_id: session.userId,
    diff: { status },
  });
  return { ok: true } as const;
}
