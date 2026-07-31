"use server";

import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const FREE_DOMAINS = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "protonmail.com", "proton.me", "live.com"]);
function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try { return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
}
function approvalFingerprint(email: string, payload: any): string {
  return [email, payload?.supplier_website ?? payload?.source_url ?? "", JSON.stringify(payload?.enrichment?.marketplace_trust ?? {})].join("|");
}

async function assertCanAct(leadId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { error: "forbidden" as const };
  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads_in_flight")
    .select("id, org_id, stage, status, payload")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead?.org_id || lead.status !== "active" || lead.stage !== "ready_for_approval" || (lead.payload as any)?.marketplace_outreach_review?.pending !== true) return { error: "lead_not_reviewable" as const };
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(lead.org_id)) return { error: "forbidden" as const };
  }
  return { session, admin, lead };
}

export async function approveMarketplaceOutreach(leadId: string, correctedEmail?: string) {
  const guard = await assertCanAct(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;
  const payload = (lead.payload as any) ?? {};
  const emailCheck = payload.enrichment?.email_check;
  const existingEmail = String(payload.supplier_contact_email ?? "").trim().toLowerCase();
  const corrected = String(correctedEmail ?? "").trim().toLowerCase();
  const existingVerified = !!existingEmail && emailCheck?.format_valid === true && emailCheck?.domain_matches_website === true && emailCheck?.is_aggregator_domain !== true;
  const websiteHost = hostOf(payload.supplier_website ?? payload.enrichment?.contact?.contact_url ?? payload.source_url);
  const correctedDomain = corrected.split("@")[1] ?? "";
  const correctedVerified = EMAIL_RE.test(corrected) && !!websiteHost && !FREE_DOMAINS.has(correctedDomain) && (correctedDomain === websiteHost || correctedDomain.endsWith(`.${websiteHost}`));
  if (!existingVerified && !correctedVerified) return { ok: false, error: "supplier_domain_email_required" };
  const approvedEmail = existingVerified ? existingEmail : corrected;
  const fingerprint = approvalFingerprint(approvedEmail, payload);
  const now = new Date().toISOString();
  const { data: updated, error } = await admin
    .from("leads_in_flight")
    .update({
      stage: "enriched",
      outreach_approved_at: now,
      outreach_approved_by: session.userId,
      outreach_reject_reason: null,
      payload: {
        ...payload,
        supplier_contact_email: approvedEmail,
        contact_owned_verified: true,
        marketplace_outreach_review: { pending: false, approved_at: now, approved_by: session.userId, corrected_email: existingVerified ? null : approvedEmail, approval_fingerprint: fingerprint },
      },
    })
    .eq("id", lead.id)
    .eq("status", "active")
    .eq("stage", "ready_for_approval")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: "lead_changed" };
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "marketplace_outreach.approved",
    target_table: "leads_in_flight",
    target_id: lead.id,
    diff: { email: approvedEmail, corrected: !existingVerified },
  });
  revalidatePath("/work/review/marketplace-outreach");
  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true };
}

export async function rejectMarketplaceOutreach(leadId: string, reason: string) {
  const guard = await assertCanAct(leadId);
  if ("error" in guard) return { ok: false, error: guard.error };
  const { session, admin, lead } = guard;
  const cleanReason = reason.trim().slice(0, 500);
  if (!cleanReason) return { ok: false, error: "reason_required" };
  const { data: updated, error } = await admin
    .from("leads_in_flight")
    .update({ status: "terminal", stage: "terminal", drop_reason: "marketplace_unverified_contact", outreach_reject_reason: cleanReason })
    .eq("id", lead.id)
    .eq("status", "active")
    .eq("stage", "ready_for_approval")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: "lead_changed" };
  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "marketplace_outreach.rejected",
    target_table: "leads_in_flight",
    target_id: lead.id,
    diff: { reason: cleanReason },
  });
  revalidatePath("/work/review/marketplace-outreach");
  revalidatePath("/work/orgs/[slug]/leads", "page");
  return { ok: true };
}
