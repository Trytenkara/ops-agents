import { stageDraft } from "@/lib/draft-staging";
import { followupDelaysMs, callingEscalateAfterMs } from "@/lib/agent-timing";
import { loadOrgStatuses, outreachAllowed } from "@/lib/org-status";
import type { createAdminClient } from "@/lib/supabase/admin";
import { randomUUID } from "crypto";

// Feature #2: pull in any supplier contact we haven't reached yet as CC on this
// nudge (same thread) — a silent primary contact shouldn't be the only shot.
// Returns the fresh contacts to CC plus the reservation id to attach on success.
// Best-effort: any failure returns no extra CCs and the nudge still goes out.
async function findUnreachedContacts(
  admin: Admin,
  r: any,
  toAddress: string
): Promise<{ cc: { name: string | null; address: string }[]; reservationId: string | null }> {
  if (!r.supplier_id || !r.thread_id) return { cc: [], reservationId: null };
  try {
    const { data: sibLeads } = await admin
      .from("leads_in_flight")
      .select("payload")
      .eq("org_id", r.org_id)
      .eq("supplier_id", r.supplier_id)
      .limit(50);
    const candidates = new Map<string, string | null>();
    const toLower = toAddress.toLowerCase();
    for (const sl of (sibLeads ?? []) as any[]) {
      const acs = (sl.payload as any)?.additional_contacts;
      if (!Array.isArray(acs)) continue;
      for (const ac of acs) {
        const e = String(ac?.email ?? "").trim().toLowerCase();
        if (e && e !== toLower) candidates.set(e, (ac?.name ?? null) as string | null);
      }
    }
    if (!candidates.size) return { cc: [], reservationId: null };
    // Drop anyone already attached to a thread (already reached on some thread).
    const { data: existing } = await admin
      .from("supplier_email_aliases")
      .select("email")
      .eq("org_id", r.org_id)
      .in("email", Array.from(candidates.keys()));
    for (const a of (existing ?? []) as any[]) candidates.delete(a.email);
    if (!candidates.size) return { cc: [], reservationId: null };

    const reservationId = randomUUID();
    const { data: reserved } = await admin.rpc("reserve_supplier_emails", {
      p_org_id: r.org_id,
      p_emails: Array.from(candidates.keys()),
      p_reservation_id: reservationId,
    });
    if (reserved !== true) {
      await admin.rpc("release_supplier_email_reservation", { p_org_id: r.org_id, p_reservation_id: reservationId });
      return { cc: [], reservationId: null };
    }
    return { cc: Array.from(candidates.entries()).map(([address, name]) => ({ address, name })), reservationId };
  } catch {
    return { cc: [], reservationId: null };
  }
}

// No-reply follow-ups (part of Agent 15). When a supplier never replies to the
// initial RFQ, draft up to two gentle nudges — at 4 and 8 days after the RFQ
// was sent — staged for a human to send. Once both nudges are out and the
// supplier is still silent, route the supplier to Cases as a calling escalation
// so a call operator can phone them. Nothing auto-sends.

const MAX_PER_RUN = 50;

// A staged draft the operator hasn't acted on yet. While one of these is sitting
// in a thread the sequence is paused: nudge #2 says "circling back", which is a
// lie if nudge #1 never left the outbox.
const PENDING_DRAFT_STATUS = new Set(["staged", "reviewed"]);

// No-reply nudge delays and calling-escalation grace are resolved per-org (see
// lib/agent-timing.ts): the compressed test cadence applies only to orgs on the
// fast-track list, every other org uses the prod defaults (4d/8d, ~day-10 call).
const MAX_ESCALATIONS_PER_RUN = 50;
const TERMINAL = new Set(["stale", "closed_declined", "finalized", "price_captured", "escalated_to_calling"]);

type Ctx = { agentId: string | null; runId: string | null; log: (m: string, o?: any) => Promise<void> };
type Admin = ReturnType<typeof createAdminClient>;

function buildFollowupBody(opts: { contactName: string | null; material: string | null; signoff: string; n: number }): string {
  const greeting = opts.contactName ? `Hi ${opts.contactName.split(/\s+/)[0]},` : "Hi there,";
  const mat = opts.material ? ` for ${opts.material}` : "";
  const opener =
    opts.n === 1
      ? `Just following up on my note below. Would you be able to share pricing${mat}?`
      : `Circling back one more time on pricing${mat}. I'd still love to get a quote from you.`;
  return [
    greeting,
    "",
    `${opener} A quote with price, pack size, lead time, and MOQ would be perfect, and I'm happy to answer any questions.`,
    "",
    "Thanks,",
    opts.signoff,
  ].join("\n");
}

// Create a calling-escalation case for a silent supplier and stamp the draft so
// we never escalate the same conversation twice. Returns true if a case was
// created. Defensive against duplicates: skips if an open calling case already
// exists for this supplier × material × org.
async function escalateToCalling(
  ctx: Ctx,
  admin: Admin,
  r: any,
  meta: any,
  followupsSent: number
): Promise<boolean> {
  const { data: existing } = await admin
    .from("cases")
    .select("id")
    .eq("org_id", r.org_id)
    .eq("type", "calling_escalation")
    .in("status", ["open", "in_progress"])
    .eq("supplier_id", r.supplier_id ?? "")
    .eq("material_id", r.material_id ?? "")
    .maybeSingle();
  if (existing) {
    // Already escalated elsewhere — stamp so we stop reconsidering it.
    await admin
      .from("draft_references")
      .update({ metadata: { ...meta, calling_escalated_at: new Date().toISOString(), flow_status: "escalated_to_calling" } })
      .eq("id", r.id);
    return false;
  }

  const supplierName = meta.supplier_name ?? r.supplier_id ?? "supplier";
  const materialName = meta.material_name ?? null;
  const silence =
    followupsSent > 0
      ? `no reply after ${followupsSent} email follow-up${followupsSent === 1 ? "" : "s"}`
      : "no reply to the initial sourcing inquiry";
  const { error: caseErr } = await admin.from("cases").insert({
    org_id: r.org_id,
    type: "calling_escalation",
    status: "open",
    supplier_id: r.supplier_id ?? null,
    material_id: r.material_id ?? null,
    originating_thread_id: r.thread_id ?? null,
    recommended_action: `Call ${supplierName}${materialName ? ` re: ${materialName}` : ""}, ${silence}. Confirm the sourcing inquiry was received and the right contact, and request a quote.`,
    assigned_operator: r.assigned_operator ?? null,
    metadata: {
      source_agent: "agent-15-reply-manager",
      source_run_id: ctx.runId,
      reason: "no_reply_after_followups",
      draft_reference_id: r.id,
      thread_id: r.thread_id ?? null,
      followup_count: Number(meta.followup_count ?? 0),
      last_followup_at: meta.last_followup_at ?? null,
      supplier_name: meta.supplier_name ?? null,
      supplier_contact_email: meta.supplier_contact_email ?? null,
      material_name: materialName,
    },
  });
  if (caseErr) {
    await ctx.log(`Calling escalation insert failed for ${supplierName}: ${caseErr.message}`, { level: "warn", step: "calling_escalation" });
    return false;
  }

  await admin
    .from("draft_references")
    .update({ metadata: { ...meta, calling_escalated_at: new Date().toISOString(), flow_status: "escalated_to_calling" } })
    .eq("id", r.id);
  await ctx.log(`Calling escalation opened for ${supplierName} (${silence})`, { step: "calling_escalation" });
  return true;
}

// Follow-up drafts already staged into a thread, keyed by thread id. The sequence
// position is derived from these rows rather than from a counter stamped at stage
// time, so a nudge the operator never sent can't advance the sequence.
async function loadFollowupsByThread(admin: Admin, threadIds: string[]): Promise<Map<string, any[]>> {
  const byThread = new Map<string, any[]>();
  for (let i = 0; i < threadIds.length; i += 100) {
    const { data } = await admin
      .from("draft_references")
      .select("thread_id, status, reviewed_at, created_at")
      .in("thread_id", threadIds.slice(i, i + 100))
      .eq("metadata->>draft_kind", "no_reply_followup");
    for (const d of (data ?? []) as any[]) {
      if (!d.thread_id) continue;
      const list = byThread.get(d.thread_id);
      if (list) list.push(d);
      else byThread.set(d.thread_id, [d]);
    }
  }
  return byThread;
}

export async function runNoReplyFollowups(ctx: Ctx, admin: Admin): Promise<{ drafted: number; skipped: number; escalated: number }> {
  let drafted = 0;
  let skipped = 0;
  let escalated = 0;

  // Only follow up on Agent 04's initial cold outreach — not re-quotes (Agent 02)
  // or reply responses (Agent 15 itself).
  const { data: a4 } = await admin.from("agents").select("id").eq("slug", "agent-04-outreach").maybeSingle();
  if (!a4?.id) {
    await ctx.log("follow-up: agent-04-outreach not found, skipping", { step: "followup" });
    return { drafted, skipped, escalated };
  }

  const { data: sent } = await admin
    .from("draft_references")
    .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata, email_client, thread_id, reviewed_at")
    .eq("agent_id", a4.id)
    .eq("status", "sent") // the RFQ was actually sent
    .is("metadata->reply_detected", null) // and got no reply
    .not("reviewed_at", "is", null) // reviewed_at = the sent timestamp (set by the webhook)
    .limit(300);

  // Per-org switch: only nudge/escalate for orgs whose switch is 'active'. A
  // paused org's in-flight RFQs stop getting follow-ups.
  const orgStatuses = await loadOrgStatuses(admin);

  const followupsByThread = await loadFollowupsByThread(
    admin,
    Array.from(new Set(((sent ?? []) as any[]).map((r) => r.thread_id).filter(Boolean)))
  );

  const now = Date.now();
  for (const r of (sent ?? []) as any[]) {
    if (drafted >= MAX_PER_RUN) break;
    const meta = (r.metadata ?? {}) as any;
    if (TERMINAL.has(meta.flow_status)) continue;
    if (!outreachAllowed(orgStatuses.byOaId.get(r.org_id) ?? "off")) continue;

    const sentAt = r.reviewed_at ? new Date(r.reviewed_at).getTime() : null;
    if (!sentAt) continue;
    // The sequence is tracked per thread; without one there's nothing to reply
    // into and no way to see the nudges we already wrote.
    if (!r.thread_id) continue;

    // Where this thread actually stands: a nudge still awaiting the operator
    // pauses the sequence, and only nudges they acted on advance it.
    const priorFollowups = followupsByThread.get(r.thread_id) ?? [];
    const awaitingOperator = priorFollowups.some((d) => PENDING_DRAFT_STATUS.has(d.status));
    const acted = priorFollowups.filter((d) => !PENDING_DRAFT_STATUS.has(d.status));
    const fu = acted.length;
    const followupsSent = acted.filter((d) => d.status === "sent").length;
    const lastOutboundAt = acted.reduce(
      (max, d) => Math.max(max, new Date(d.reviewed_at ?? d.created_at).getTime()),
      sentAt
    );

    // Per-org cadence: compressed only for the fast-track orgs, prod defaults elsewhere.
    const followupDelays = followupDelaysMs(r.org_id);

    // Both follow-ups out and still silent → escalate to a phone call once the
    // grace window has elapsed. Stamped via calling_escalated_at so we only do
    // this once per conversation.
    if (fu >= followupDelays.length) {
      if (meta.calling_escalated_at) continue;
      if (escalated >= MAX_ESCALATIONS_PER_RUN) continue;
      if ((now - lastOutboundAt) < callingEscalateAfterMs(r.org_id)) continue; // grace not elapsed
      if (await escalateToCalling(ctx, admin, r, meta, followupsSent)) escalated++;
      continue;
    }

    if (awaitingOperator) continue; // nudge #N still unsent, don't write #N+1 over it

    // Due on the original cadence (days since the RFQ), but never closer to the
    // previous nudge than that cadence's own spacing — an operator who sends
    // nudge #1 late shouldn't get nudge #2 on the next tick.
    const dueAt = Math.max(
      sentAt + followupDelays[fu],
      fu > 0 ? lastOutboundAt + (followupDelays[fu] - followupDelays[fu - 1]) : 0
    );
    if (now < dueAt) continue; // not due yet

    const to = meta.supplier_contact_email as string | undefined;
    if (!to) {
      skipped++;
      continue;
    }
    const signoff = meta.suggested_signoff ?? meta.ghost_brand ?? "Sourcing Team";
    const body = buildFollowupBody({
      contactName: meta.supplier_name ?? null,
      material: meta.material_name ?? null,
      signoff,
      n: fu + 1,
    });

    // Feature #2: bring any not-yet-reached supplier contact onto this thread as
    // a CC, so a silent primary isn't our only shot.
    const { cc: freshCc, reservationId: ccReservationId } = await findUnreachedContacts(admin, r, to);

    const staged = await stageDraft({
      admin,
      agentId: ctx.agentId,
      runId: ctx.runId,
      orgId: r.org_id,
      supplierId: r.supplier_id,
      materialId: r.material_id,
      to: { name: meta.supplier_name ?? null, address: to },
      cc: freshCc,
      subject: (r.subject ?? "").startsWith("Re:") ? r.subject : `Re: ${r.subject ?? "your quote"}`,
      body,
      assignedOperator: r.assigned_operator ?? null,
      conversationId: r.thread_id ?? null, // reply into the original thread
      metadata: {
        outreach_mode: meta.outreach_mode ?? "ghost",
        ghost_brand: meta.ghost_brand ?? null,
        supplier_contact_email: to,
        supplier_name: meta.supplier_name ?? null,
        draft_kind: "no_reply_followup",
        followup_n: fu + 1,
        staged_via: "agent-15-followup",
      },
    });

    if (staged.ok) {
      drafted++;
      // Attach the freshly-CC'd contacts to this thread so we don't re-CC them.
      if (ccReservationId) {
        await admin
          .from("supplier_email_aliases")
          .update({ thread_id: r.thread_id ?? null, draft_ref_id: r.id, supplier_id: r.supplier_id ?? null, supplier_name: meta.supplier_name ?? null, claim_status: "attached", reservation_id: null })
          .eq("reservation_id", ccReservationId)
          .eq("claim_status", "reserved");
      }
      // followup_count is what the operator sees as "N follow-ups sent", so it
      // records nudges that actually went out, not the one just staged.
      await admin
        .from("draft_references")
        .update({
          metadata: {
            ...meta,
            followup_count: followupsSent,
            last_followup_at: fu > 0 ? new Date(lastOutboundAt).toISOString() : (meta.last_followup_at ?? null),
          },
        })
        .eq("id", r.id);
      await ctx.log(`No-reply follow-up #${fu + 1} drafted for ${meta.supplier_name ?? to}${freshCc.length ? ` (+${freshCc.length} new contact${freshCc.length === 1 ? "" : "s"} CC'd)` : ""}`, { step: "followup" });
    } else {
      skipped++;
      if (ccReservationId) await admin.rpc("release_supplier_email_reservation", { p_org_id: r.org_id, p_reservation_id: ccReservationId });
      await ctx.log(`Follow-up stage failed for ${to}: ${staged.error}`, { level: "warn", step: "followup" });
    }
  }

  return { drafted, skipped, escalated };
}
