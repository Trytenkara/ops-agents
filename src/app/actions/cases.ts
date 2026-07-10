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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Operator found an email for a "no public email" supplier. Record it on the
// dropped lead and requeue it (stage=enriched, status=active) so the next
// Agent 04 sweep drafts a real outreach email, then resolve the manual case.
export async function addSupplierEmailToCase(caseId: string, email: string) {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" } as const;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" } as const;

  const clean = (email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(clean)) return { ok: false, error: "invalid email" } as const;

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("cases")
    .select("id, org_id, type, status, metadata")
    .eq("id", caseId)
    .maybeSingle();
  if (!row) return { ok: false, error: "case not found" } as const;
  if (row.type !== "manual_outreach") return { ok: false, error: "not a manual-outreach case" } as const;
  if (row.status === "resolved") return { ok: false, error: "already resolved" } as const;

  const leadId = (row.metadata as any)?.lead_id as string | undefined;
  if (!leadId) return { ok: false, error: "case has no linked lead" } as const;

  const { data: lead } = await admin
    .from("leads_in_flight")
    .select("id, payload")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { ok: false, error: "linked lead not found" } as const;

  const payload = (lead.payload ?? {}) as Record<string, any>;
  const { drop_reason: _drop, ...restPayload } = payload;
  const mergedPayload = {
    ...restPayload,
    supplier_contact_email: clean,
    enrichment: {
      ...(payload.enrichment ?? {}),
      email_check: { email: clean, format_valid: true, domain_matches_website: null },
    },
    email_source: "manual_operator",
    manual_email_added_by: session.userId,
    manual_email_added_at: new Date().toISOString(),
  };

  const { error: leadErr } = await admin
    .from("leads_in_flight")
    .update({ stage: "enriched", status: "active", payload: mergedPayload })
    .eq("id", leadId);
  if (leadErr) return { ok: false, error: leadErr.message } as const;

  const { error: caseErr } = await admin
    .from("cases")
    .update({
      status: "resolved",
      resolution_note: `Email added manually: ${clean} — lead requeued for outreach`,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", caseId);
  if (caseErr) return { ok: false, error: caseErr.message } as const;

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "case.email_added",
    target_table: "cases",
    target_id: caseId,
    diff: { supplier_contact_email: clean, lead_id: leadId },
  });

  revalidatePath(`/work/orgs/[slug]/cases`, "page");
  return { ok: true } as const;
}
