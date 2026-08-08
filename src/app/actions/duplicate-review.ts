"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { PROMOTABLE_STAGES } from "@/lib/lead-dupe-guard";

// An operator's verdict on a lead Agent 20 parked as a likely duplicate.
//
//   same      → it is the company we already have. Drop the lead.
//   different → a genuinely separate company. Put it back where it was, so
//               Tenkara promotes it on the next run.
//
// Both verdicts also resolve the case, because the case exists only to ask this
// question. Neither touches Tenkara: dropping prevents a supplier row from ever
// being created, which is the whole point of parking rather than reviewing after.
export type DuplicateVerdict = "same" | "different";

export async function resolveDuplicateLead(
  leadId: string,
  verdict: DuplicateVerdict,
  note?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" };

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads_in_flight")
    .select("id, org_id, stage, status, supplier_name, payload")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "lead_not_found" };

  if (!seesAllOrgs(session)) {
    if (!lead.org_id) return { ok: false, error: "forbidden" };
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(lead.org_id)) return { ok: false, error: "forbidden" };
  }
  if (lead.status !== "active") return { ok: false, error: "lead_already_terminal" };

  const payload = (lead.payload as any) ?? {};
  const review = payload.duplicate_review;
  if (!review?.pending) return { ok: false, error: "not_parked_as_duplicate" };

  const decided = {
    ...review,
    pending: false,
    verdict,
    decided_by: session.userId,
    decided_at: new Date().toISOString(),
    ...(note?.trim() ? { note: note.trim() } : {}),
  };

  if (verdict === "same") {
    const { error } = await admin
      .from("leads_in_flight")
      .update({
        status: "terminal",
        drop_reason: `duplicate: already a supplier on ${review.domain}`,
        payload: {
          ...payload,
          duplicate_review: decided,
          dropped_by: session.userId,
          dropped_at: new Date().toISOString(),
          drop_reason_code: "duplicate",
        },
      })
      .eq("id", leadId)
      .eq("status", "active");
    if (error) return { ok: false, error: error.message };
  } else {
    // Back to the stage it was parked from, so it re-enters the promote queue.
    const back = PROMOTABLE_STAGES.includes(review.parked_from_stage) ? review.parked_from_stage : "enriched";
    const { error } = await admin
      .from("leads_in_flight")
      .update({ stage: back, payload: { ...payload, duplicate_review: decided } })
      .eq("id", leadId)
      .eq("status", "active");
    if (error) return { ok: false, error: error.message };
  }

  await admin
    .from("cases")
    .update({
      status: "resolved",
      resolution_note:
        verdict === "same"
          ? `Same company as the existing supplier on ${review.domain}. Lead dropped.`
          : `Confirmed a different company. Lead sent back to the pipeline.`,
      resolved_at: new Date().toISOString(),
    })
    .eq("type", "duplicate_supplier")
    .eq("org_id", lead.org_id)
    .eq("metadata->>lead_id", leadId)
    .in("status", ["open", "in_progress"]);

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "lead.duplicate_reviewed",
    target_table: "leads_in_flight",
    target_id: leadId,
    diff: { verdict, domain: review.domain, existing: review.existing_supplier_names ?? null },
  });

  revalidatePath(`/work/orgs/[slug]/leads`, "page");
  return { ok: true };
}
