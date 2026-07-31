"use server";

import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LIVE_THREAD_STATUSES = ["staged", "reviewed", "sent", "linked"];

async function canActOnOrg(orgId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { error: "forbidden" as const };
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) return { error: "forbidden" as const };
  }
  return { session, admin: createAdminClient() };
}

export async function attachAlternateEmail(orgId: string, draftRefId: string, rawEmail: string) {
  const guard = await canActOnOrg(orgId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin } = guard;
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "invalid_email" };

  const { data: draft } = await admin
    .from("draft_references")
    .select("id, org_id, thread_id, supplier_id, status, metadata, email_client")
    .eq("id", draftRefId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!draft || !draft.thread_id || draft.email_client !== "rod_app" || !LIVE_THREAD_STATUSES.includes(draft.status)) {
    return { ok: false, error: "thread_not_attachable" };
  }

  const { data: existing } = await admin
    .from("supplier_email_aliases")
    .select("id, thread_id")
    .eq("org_id", orgId)
    .eq("email", email)
    .maybeSingle();
  if (existing && existing.thread_id !== draft.thread_id) return { ok: false, error: "email_already_attached_to_other_thread" };
  if (existing) return { ok: true };
  if (!existing) {
    const { error } = await admin.from("supplier_email_aliases").insert({
      org_id: orgId,
      email,
      supplier_id: draft.supplier_id,
      thread_id: draft.thread_id,
      draft_ref_id: draft.id,
      supplier_name: (draft.metadata as any)?.supplier_name ?? null,
      added_by: session.userId,
      claim_status: "attached",
    });
    if (error) return { ok: false, error: error.message };
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "supplier_email_alias.attached",
    target_table: "draft_references",
    target_id: draft.id,
    diff: { email, thread_id: draft.thread_id },
  });
  revalidatePath("/work/orgs/[slug]/threads", "page");
  return { ok: true };
}

