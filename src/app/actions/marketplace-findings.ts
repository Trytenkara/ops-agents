"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";

interface ActionResult {
  ok: boolean;
  error?: string;
}

async function assertCanActOnFinding(findingId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return { error: "forbidden" as const };
  }
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("marketplace_check_findings")
    .select("id, org_id, status")
    .eq("id", findingId)
    .maybeSingle();
  if (!row) return { error: "not_found" as const };
  if (!seesAllOrgs(session)) {
    if (!row.org_id) return { error: "forbidden" as const };
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(row.org_id)) {
      return { error: "forbidden" as const };
    }
  }
  return { session, admin, row };
}

export async function approveFinding(findingId: string): Promise<ActionResult> {
  const ctx = await assertCanActOnFinding(findingId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { session, admin } = ctx;
  const { error } = await admin
    .from("marketplace_check_findings")
    .update({
      status: "approved",
      approved_by: session.userId,
      approved_at: new Date().toISOString(),
      dismissed_by: null,
      dismissed_at: null,
    })
    .eq("id", findingId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/work/review/marketplace");
  return { ok: true };
}

export async function dismissFinding(findingId: string): Promise<ActionResult> {
  const ctx = await assertCanActOnFinding(findingId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { session, admin } = ctx;
  const { error } = await admin
    .from("marketplace_check_findings")
    .update({
      status: "dismissed",
      dismissed_by: session.userId,
      dismissed_at: new Date().toISOString(),
      approved_by: null,
      approved_at: null,
    })
    .eq("id", findingId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/work/review/marketplace");
  return { ok: true };
}

export async function reopenFinding(findingId: string): Promise<ActionResult> {
  const ctx = await assertCanActOnFinding(findingId);
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { admin } = ctx;
  const { error } = await admin
    .from("marketplace_check_findings")
    .update({
      status: "pending_review",
      approved_by: null,
      approved_at: null,
      dismissed_by: null,
      dismissed_at: null,
    })
    .eq("id", findingId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/work/review/marketplace");
  return { ok: true };
}
