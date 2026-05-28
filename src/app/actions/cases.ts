"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function resolveCase(caseId: string, resolutionNote: string) {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" } as const;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" } as const;

  const admin = createAdminClient();
  const { data: row } = await admin.from("cases").select("id, org_id, status").eq("id", caseId).maybeSingle();
  if (!row) return { ok: false, error: "case not found" } as const;
  if (row.status === "resolved") return { ok: false, error: "already resolved" } as const;

  const { error } = await admin
    .from("cases")
    .update({
      status: "resolved",
      resolution_note: resolutionNote || null,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", caseId);
  if (error) return { ok: false, error: error.message } as const;

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "case.resolved",
    target_table: "cases",
    target_id: caseId,
    diff: { resolution_note: resolutionNote || null },
  });

  revalidatePath(`/work/orgs/[slug]/cases`, "page");
  return { ok: true } as const;
}
