"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAggregatorEmail } from "@/agents-runtime/agents/data-enrichment/enrich";
import { splitDirectLeadFromMarketplace, isMarketplaceLeadPayload } from "@/lib/marketplace-direct-split";
import { dialablePhone, CALL_OUTCOMES, type CallOutcome } from "@/lib/call-brief";

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

// Record a call attempt on a calling escalation. Each attempt is appended, never
// overwritten: "called three times, two voicemails" is the evidence for dropping
// a supplier, and it only exists if every attempt is kept.
export async function logCallAttempt(caseId: string, outcome: CallOutcome, note: string) {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" } as const;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" } as const;
  const spec = CALL_OUTCOMES[outcome];
  if (!spec) return { ok: false, error: "unknown outcome" } as const;

  const admin = createAdminClient();
  const { data: row } = await admin.from("cases").select("id, type, status, metadata").eq("id", caseId).maybeSingle();
  if (!row) return { ok: false, error: "case not found" } as const;
  if (row.type !== "calling_escalation") return { ok: false, error: "not a calling escalation" } as const;
  if (row.status === "resolved") return { ok: false, error: "already resolved" } as const;

  const metadata = (row.metadata ?? {}) as Record<string, any>;
  const cleanNote = (note ?? "").trim();
  const attempt = {
    at: new Date().toISOString(),
    by: session.userId,
    outcome,
    note: cleanNote || null,
  };
  const callLog = [...(Array.isArray(metadata.call_log) ? metadata.call_log : []), attempt];

  // A wrong number is worse than no number: leaving it on the brief sends the
  // next operator back to the same dead line.
  const brief = metadata.call_brief ? { ...(metadata.call_brief as Record<string, any>) } : null;
  if (brief && outcome === "wrong_number") {
    brief.contact = { ...(brief.contact ?? {}), phone: null, phoneSource: null };
    brief.phoneStatus = "missing";
  }

  const patch: Record<string, any> = {
    metadata: { ...metadata, call_log: callLog, ...(brief ? { call_brief: brief } : {}) },
  };
  if (spec.terminal) {
    patch.status = "resolved";
    patch.resolved_at = new Date().toISOString();
    patch.resolution_note = `${spec.label} by phone${cleanNote ? `: ${cleanNote}` : ""}`;
  } else {
    patch.status = "in_progress";
  }

  const { error } = await admin.from("cases").update(patch).eq("id", caseId);
  if (error) return { ok: false, error: error.message } as const;

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "case.call_logged",
    target_table: "cases",
    target_id: caseId,
    diff: attempt,
  });

  revalidatePath(`/work/orgs/[slug]/threads`, "page");
  return { ok: true, resolved: spec.terminal } as const;
}

// Operator found a number for a supplier we had none for. Store it on the brief
// AND write it back to the lead, so the next escalation for this supplier and
// every export carries it too.
export async function addSupplierPhoneToCase(caseId: string, phone: string) {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" } as const;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" } as const;

  const clean = dialablePhone(phone);
  if (!clean) return { ok: false, error: "not a dialable number" } as const;

  const admin = createAdminClient();
  const { data: row } = await admin.from("cases").select("id, type, status, metadata").eq("id", caseId).maybeSingle();
  if (!row) return { ok: false, error: "case not found" } as const;
  if (row.type !== "calling_escalation") return { ok: false, error: "not a calling escalation" } as const;
  if (row.status === "resolved") return { ok: false, error: "already resolved" } as const;

  const metadata = (row.metadata ?? {}) as Record<string, any>;
  const brief = { ...((metadata.call_brief ?? {}) as Record<string, any>) };
  brief.contact = { ...(brief.contact ?? {}), phone: clean, phoneSource: "manual_operator" };
  brief.phoneStatus = "known";

  const { error } = await admin
    .from("cases")
    .update({ metadata: { ...metadata, call_brief: brief } })
    .eq("id", caseId);
  if (error) return { ok: false, error: error.message } as const;

  const leadId = (metadata.lead_id ?? brief.leadId) as string | undefined;
  if (leadId) {
    const { data: lead } = await admin.from("leads_in_flight").select("id, payload").eq("id", leadId).maybeSingle();
    if (lead) {
      const payload = ((lead as any).payload ?? {}) as Record<string, any>;
      const enrichment = { ...(payload.enrichment ?? {}) };
      enrichment.contact = { ...(enrichment.contact ?? {}), phone: clean };
      await admin
        .from("leads_in_flight")
        .update({ payload: { ...payload, supplier_phone: clean, enrichment, phone_source: "manual_operator" } })
        .eq("id", leadId);
    }
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "case.phone_added",
    target_table: "cases",
    target_id: caseId,
    diff: { phone: clean, lead_id: leadId ?? null },
  });

  revalidatePath(`/work/orgs/[slug]/threads`, "page");
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

  // A marketplace or aggregator lead does not become a direct supplier just
  // because we now hold an address: the listing is still a listing, and the
  // price index publishes from it. Stand the direct supplier up as its own lead
  // and leave this row on the marketplace track.
  if (isMarketplaceLeadPayload(payload) && !isAggregatorEmail(clean)) {
    const split = await splitDirectLeadFromMarketplace(admin, { leadId, contactEmail: clean, trigger: "operator" });
    if (!split.split) return { ok: false, error: `could not create the direct lead (${split.reason})` } as const;
    const { data: directLead } = await admin.from("leads_in_flight").select("payload").eq("id", split.directLeadId).maybeSingle();
    await admin
      .from("leads_in_flight")
      .update({
        payload: {
          ...(((directLead?.payload ?? {}) as Record<string, any>)),
          email_source: "manual_operator",
          manual_email_added_by: session.userId,
          manual_email_added_at: new Date().toISOString(),
        },
      })
      .eq("id", split.directLeadId);

    const { error: mpCaseErr } = await admin
      .from("cases")
      .update({
        status: "resolved",
        resolution_note: `Email added manually: ${clean} — staged as a direct supplier lead alongside the ${payload.aggregator ?? "marketplace"} listing`,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", caseId);
    if (mpCaseErr) return { ok: false, error: mpCaseErr.message } as const;

    await admin.from("audit_log").insert({
      actor_user_id: session.userId,
      action: "case.email_added",
      target_table: "cases",
      target_id: caseId,
      diff: { supplier_contact_email: clean, lead_id: leadId, direct_lead_id: split.directLeadId },
    });

    revalidatePath(`/work/orgs/[slug]/cases`, "page");
    return { ok: true } as const;
  }

  const { drop_reason: _drop, ...restPayload } = payload;
  const mergedPayload = {
    ...restPayload,
    supplier_contact_email: clean,
    enrichment: {
      ...(payload.enrichment ?? {}),
      email_check: { email: clean, format_valid: true, domain_matches_website: null, is_aggregator_domain: isAggregatorEmail(clean) },
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
