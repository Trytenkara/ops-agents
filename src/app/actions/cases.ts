"use server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAggregatorEmail } from "@/agents-runtime/agents/data-enrichment/enrich";
import { splitDirectLeadFromMarketplace, isMarketplaceLeadPayload } from "@/lib/marketplace-direct-split";
import { applyContactChange } from "@/lib/contact-change";
import { dialablePhone, buildCallBrief, CALL_OUTCOMES, type CallOutcome } from "@/lib/call-brief";
import { CallOperatorResolver, notifyCallEscalation } from "@/lib/call-escalation";
import { stageDraft, threadCcContacts } from "@/lib/draft-staging";
import { buildCallFollowupBody } from "@/lib/call-followup";

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

// Load a calling escalation an operator is allowed to act on. Every caller-jobs
// action needs the same four checks, and getting one of them wrong would let a
// resolved case be reopened or a non-call case be dropped through the phone UI.
async function openCallCase(caseId: string) {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" } as const;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { error: "forbidden" } as const;

  const admin = createAdminClient();
  const { data: row } = await admin.from("cases").select("id, org_id, type, status, metadata").eq("id", caseId).maybeSingle();
  if (!row) return { error: "case not found" } as const;
  if (row.type !== "calling_escalation") return { error: "not a calling escalation" } as const;
  if (row.status === "resolved") return { error: "already resolved" } as const;
  return { session, admin, row } as const;
}

// The supplier is workable again, so hand them back to the email cadence.
//
// The nudge sweep stops at flow_status='escalated_to_calling' (that is how the
// email side closes a conversation out), so clearing it is what actually resumes
// the sequence. The call stages already raised are left stamped: a supplier who
// came back to life does not owe us the calls that got them there.
export async function deescalateCallCase(
  caseId: string,
  input: { callResults: Record<string, "success" | "failure">; note: string }
) {
  const guard = await openCallCase(caseId);
  if ("error" in guard) return { ok: false, error: guard.error } as const;
  const { session, admin, row } = guard;

  const note = (input.note ?? "").trim();
  const results = Object.entries(input.callResults ?? {})
    .filter(([, v]) => v === "success" || v === "failure")
    .map(([stage, v]) => `call ${stage} ${v}`);

  const metadata = (row.metadata ?? {}) as Record<string, any>;
  const { error } = await admin
    .from("cases")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolution_note: `Back in the email loop${results.length ? ` (${results.join(", ")})` : ""}${note ? `: ${note}` : ""}`,
      metadata: {
        ...metadata,
        deescalated_at: new Date().toISOString(),
        deescalated_by: session.userId,
        call_results: input.callResults ?? {},
        deescalation_note: note || null,
      },
    })
    .eq("id", caseId);
  if (error) return { ok: false, error: error.message } as const;

  const draftId = metadata.draft_reference_id as string | undefined;
  let followupDraftRefId: string | undefined;
  if (draftId) {
    const { data: draft } = await admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, agent_id, thread_id, subject, assigned_operator, metadata")
      .eq("id", draftId)
      .maybeSingle();
    if (draft) {
      const draftRow = draft as any;
      const meta = (draftRow.metadata ?? {}) as Record<string, any>;
      if (meta.flow_status === "escalated_to_calling") {
        await admin
          .from("draft_references")
          .update({ metadata: { ...meta, flow_status: "outreach_sent", deescalated_from_calling_at: new Date().toISOString() } })
          .eq("id", draftId);
      }

      // Draft the follow-up right away, reflecting whatever the call surfaced
      // (call notes, Granola paste), and hand it to the email operator, not the
      // caller: this task closes out with the caller, the reply is the email
      // side's to work.
      const contactEmail = meta.supplier_contact_email as string | undefined;
      if (contactEmail && draftRow.org_id) {
        const routing = await new CallOperatorResolver(admin as any).route({
          orgId: draftRow.org_id,
          assignedOperator: draftRow.assigned_operator ?? null,
          supplierId: draftRow.supplier_id ?? null,
          supplierName: (meta.supplier_name as string | undefined) ?? null,
        });
        const cc = await threadCcContacts(admin as any, draftRow.thread_id, contactEmail);
        const callLog: Array<{ outcome: string; note: string | null }> = Array.isArray(metadata.call_log) ? metadata.call_log : [];
        const body = buildCallFollowupBody({
          contactName: (meta.supplier_contact_name as string | undefined) ?? null,
          materialName: (meta.material_name as string | undefined) ?? null,
          callLog: callLog as any,
          signoff: (meta.suggested_signoff as string | undefined) ?? (meta.ghost_brand as string | undefined) ?? "Sourcing Team",
        });
        const staged = await stageDraft({
          admin: admin as any,
          agentId: draftRow.agent_id ?? null,
          runId: null,
          orgId: draftRow.org_id,
          supplierId: draftRow.supplier_id ?? null,
          materialId: draftRow.material_id ?? null,
          to: { name: (meta.supplier_contact_name as string | undefined) ?? null, address: contactEmail },
          cc: cc.map((address) => ({ address })),
          subject: draftRow.subject ? `Re: ${draftRow.subject.replace(/^Re:\s*/i, "")}` : "Following up",
          body,
          assignedOperator: routing.emailOperator?.userId ?? null,
          conversationId: draftRow.thread_id ?? null,
          metadata: {
            ...meta,
            draft_kind: "call_followup",
            source_case_id: caseId,
            // Reset org-level branding to the actual call case's org, not the original draft's
            ghost_brand: null,
            suggested_signoff: null,
            outreach_mode: "active",
          },
        }).catch((e: any) => ({ ok: false, error: e?.message ?? String(e) }) as const);
        if (staged.ok) followupDraftRefId = (staged as any).draftRefId;
      }
    }
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "case.call_deescalated",
    target_table: "cases",
    target_id: caseId,
    diff: { call_results: input.callResults ?? {}, note: note || null, draft_reference_id: draftId ?? null, followup_draft_reference_id: followupDraftRefId ?? null },
  });

  revalidatePath(`/work/orgs/[slug]/calls`, "page");
  return { ok: true } as const;
}

// Nobody ever answered, by email or by phone. Drop the supplier's lead so it
// stops being worked, and resolve the call task with the operator's reason.
export async function dropSupplierFromCallCase(caseId: string, note: string) {
  const guard = await openCallCase(caseId);
  if ("error" in guard) return { ok: false, error: guard.error } as const;
  const { session, admin, row } = guard;

  const clean = (note ?? "").trim();
  if (!clean) return { ok: false, error: "say why you are dropping them" } as const;

  const metadata = (row.metadata ?? {}) as Record<string, any>;
  const leadId = (metadata.lead_id ?? metadata.call_brief?.leadId) as string | undefined;
  if (leadId) {
    const { data: lead } = await admin.from("leads_in_flight").select("id, payload").eq("id", leadId).maybeSingle();
    if (lead) {
      const payload = ((lead as any).payload ?? {}) as Record<string, any>;
      await admin
        .from("leads_in_flight")
        .update({
          status: "terminal",
          drop_reason: `no_reply_after_calling: ${clean}`,
          payload: {
            ...payload,
            dropped_by: session.userId,
            dropped_at: new Date().toISOString(),
            drop_reason_code: "no_reply_after_calling",
            drop_reason_note: clean,
          },
        })
        .eq("id", leadId)
        .eq("status", "active");
    }
  }

  const { error } = await admin
    .from("cases")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolution_note: `Supplier dropped, never reached: ${clean}`,
      metadata: { ...metadata, dropped_at: new Date().toISOString(), dropped_by: session.userId, drop_note: clean },
    })
    .eq("id", caseId);
  if (error) return { ok: false, error: error.message } as const;

  const draftId = metadata.draft_reference_id as string | undefined;
  if (draftId) {
    const { data: draft } = await admin.from("draft_references").select("id, metadata").eq("id", draftId).maybeSingle();
    if (draft) {
      const meta = ((draft as any).metadata ?? {}) as Record<string, any>;
      await admin
        .from("draft_references")
        .update({ metadata: { ...meta, flow_status: "closed_declined", dropped_after_calling_at: new Date().toISOString() } })
        .eq("id", draftId);
    }
  }

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "case.supplier_dropped",
    target_table: "cases",
    target_id: caseId,
    diff: { note: clean, lead_id: leadId ?? null },
  });

  revalidatePath(`/work/orgs/[slug]/calls`, "page");
  return { ok: true } as const;
}

// A pasted Granola call-notes transcript, attached as context for whoever
// drafts the follow-up when this case goes back to email. Overwrites rather
// than appends: it's one paste box per call, not a log, and an operator
// correcting a paste should replace it, not stack a second copy underneath.
export async function addGranolaNotesToCase(caseId: string, notes: string) {
  const guard = await openCallCase(caseId);
  if ("error" in guard) return { ok: false, error: guard.error } as const;
  const { session, admin, row } = guard;

  const clean = (notes ?? "").trim();
  const metadata = (row.metadata ?? {}) as Record<string, any>;

  const { error } = await admin
    .from("cases")
    .update({
      metadata: {
        ...metadata,
        granola_notes: clean || null,
        granola_notes_added_by: clean ? session.userId : null,
        granola_notes_added_at: clean ? new Date().toISOString() : null,
      },
    })
    .eq("id", caseId);
  if (error) return { ok: false, error: error.message } as const;

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "case.granola_notes_added",
    target_table: "cases",
    target_id: caseId,
    diff: { has_notes: !!clean },
  });

  revalidatePath(`/work/orgs/[slug]/calls`, "page");
  return { ok: true } as const;
}

// Suppliers an operator can pick from for a manually-logged ("stray") call: any
// active lead on this org, name-matched. Never a free-typed new supplier — a
// stray call is still tied to a real lead so the case links up like every other
// one (phone lookups, drop/deescalate, the lead itself).
export async function searchOrgLeadsForCall(orgId: string, query: string) {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" } as const;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" } as const;

  const admin = createAdminClient();
  const q = (query ?? "").trim();
  let builder = admin
    .from("leads_in_flight")
    .select("id, supplier_id, supplier_name, material_id, material_name, payload")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(20);
  if (q) builder = builder.ilike("supplier_name", `%${q}%`);
  const { data, error } = await builder;
  if (error) return { ok: false, error: error.message } as const;

  return {
    ok: true,
    leads: (data ?? []).map((r: any) => ({
      leadId: r.id as string,
      supplierId: r.supplier_id as string | null,
      supplierName: (r.supplier_name as string | null) ?? (r.payload?.supplier_name as string | null) ?? "Unknown supplier",
      materialName: (r.material_name as string | null) ?? (r.payload?.material_name as string | null) ?? null,
      contactEmail: (r.payload?.supplier_contact_email as string | null) ?? null,
      contactName: (r.payload?.supplier_contact_name as string | null) ?? null,
    })),
  } as const;
}

// An operator raises a call task the scheduled cadence never would have (an
// inbound call, a lead someone wants to chase early, whatever). Same shape as
// an automated call task -- same CallBrief, same routing, same Slack post --
// just with the reason/asks typed by the operator instead of composed from a
// draft's thread history, since there usually isn't one.
export async function createManualCallTask(input: { orgId: string; leadId: string; reason: string }) {
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthenticated" } as const;
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) return { ok: false, error: "forbidden" } as const;

  const reason = (input.reason ?? "").trim();
  if (!reason) return { ok: false, error: "say why this call is needed" } as const;

  const admin = createAdminClient();
  const { data: lead } = await admin
    .from("leads_in_flight")
    .select("id, org_id, supplier_id, supplier_name, material_id, material_name, payload")
    .eq("id", input.leadId)
    .eq("org_id", input.orgId)
    .eq("status", "active")
    .maybeSingle();
  if (!lead) return { ok: false, error: "lead not found" } as const;

  const payload = ((lead as any).payload ?? {}) as Record<string, any>;
  const supplierName = (lead as any).supplier_name ?? payload.supplier_name ?? null;
  const materialName = (lead as any).material_name ?? payload.material_name ?? null;
  const meta: Record<string, any> = {
    supplier_name: supplierName,
    supplier_contact_email: payload.supplier_contact_email ?? null,
    supplier_contact_name: payload.supplier_contact_name ?? null,
    material_name: materialName,
    required_grade: payload.required_grade ?? null,
    lead_id: (lead as any).id,
  };

  const { data: existing } = await admin
    .from("cases")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("type", "calling_escalation")
    .in("status", ["open", "in_progress"])
    .eq("supplier_id", (lead as any).supplier_id ?? "")
    .eq("material_id", (lead as any).material_id ?? "")
    .maybeSingle();
  if (existing) return { ok: false, error: "this supplier already has an open call task" } as const;

  const brief = await buildCallBrief(admin as any, {
    orgId: input.orgId,
    supplierId: (lead as any).supplier_id ?? null,
    meta,
    subject: null,
    threadId: null,
    inquirySentAt: null,
    followupSentAt: [],
    followupsSent: 0,
    callStage: 0,
    manualReason: reason,
  });

  const resolver = new CallOperatorResolver(admin as any);
  const routing = await resolver.route({
    orgId: input.orgId,
    assignedOperator: null,
    supplierId: (lead as any).supplier_id ?? null,
    supplierName,
  });

  const phoneLine = brief.contact.phone ? ` on ${brief.contact.phone}` : " (no number on file, find one first)";
  const { data: created, error: caseErr } = await admin
    .from("cases")
    .insert({
      org_id: input.orgId,
      type: "calling_escalation",
      status: "open",
      supplier_id: (lead as any).supplier_id ?? null,
      material_id: (lead as any).material_id ?? null,
      recommended_action: `Call ${supplierName ?? "supplier"}${phoneLine}${materialName ? ` re: ${materialName}` : ""}. ${reason}`,
      assigned_operator: routing.caller?.userId ?? null,
      metadata: {
        source: "manual_operator",
        source_user_id: session.userId,
        reason: "manual",
        call_stage: 0,
        supplier_name: supplierName,
        supplier_contact_email: meta.supplier_contact_email,
        material_name: materialName,
        lead_id: (lead as any).id,
        call_brief: brief,
      },
    })
    .select("id")
    .maybeSingle();
  if (caseErr) return { ok: false, error: caseErr.message } as const;

  const [orgSlug, orgName] = await Promise.all([resolver.orgSlug(input.orgId), resolver.orgName(input.orgId)]);
  await notifyCallEscalation({ brief, routing, orgName, orgSlug, reason, origin: "operator" });

  await admin.from("audit_log").insert({
    actor_user_id: session.userId,
    action: "case.manual_call_created",
    target_table: "cases",
    target_id: created?.id ?? null,
    diff: { lead_id: (lead as any).id, reason },
  });

  revalidatePath(`/work/orgs/[slug]/calls`, "page");
  return { ok: true, caseId: created?.id } as const;
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
    .select("id, org_id, supplier_id, payload")
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
          // Both markers, deliberately. email_source is what this screen has
          // always written; contact_source is what the outreach agents read to
          // tell a hand-added address from a scraped one, and without it an
          // email added here is invisible to Agent 22.
          email_source: "manual_operator",
          contact_source: "manual_operator",
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
    contact_source: "manual_operator",
    manual_email_added_by: session.userId,
    manual_email_added_at: new Date().toISOString(),
  };

  // Same retirement the inline editor performs: the address this case was opened
  // about is usually a bounced or wrong one, and leaving it in additional_contacts
  // (or leaving its draft live in the inbox) means we mail it again.
  const change = await applyContactChange(admin, {
    lead: { id: leadId, org_id: lead.org_id, supplier_id: lead.supplier_id },
    payload: mergedPayload,
    previous: String(payload.supplier_contact_email ?? "") || null,
    next: clean,
    reason: "replaced",
    actorUserId: session.userId,
  });

  const { error: leadErr } = await admin
    .from("leads_in_flight")
    .update({ stage: "enriched", status: "active", payload: change.payload })
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
