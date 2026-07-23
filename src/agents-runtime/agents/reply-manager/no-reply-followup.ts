import { stageDraft } from "@/lib/draft-staging";
import type { createAdminClient } from "@/lib/supabase/admin";

// No-reply follow-ups (part of Agent 15). When a supplier never replies to the
// initial RFQ, draft up to two gentle nudges — at 4 and 8 days after the RFQ
// was sent — staged for a human to send. Once both nudges are out and the
// supplier is still silent, route the supplier to Cases as a calling escalation
// so a call operator can phone them. Nothing auto-sends.

const DAY = 24 * 3600 * 1000;
const MINUTE = 60 * 1000;
const MAX_PER_RUN = 50;

// Delay before each no-reply nudge, as ms-after-sent. Prod default is 4d/8d.
// FOLLOWUP_MINUTES (csv, e.g. "5,10") overrides for testing so both nudges fire
// within a session; the list length also sets how many nudges we send.
const FOLLOWUP_DELAYS_MS: number[] = (() => {
  const raw = (process.env.FOLLOWUP_MINUTES ?? "").trim();
  if (raw) {
    const mins = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
    if (mins.length) return mins.map((m) => m * MINUTE);
  }
  return [4 * DAY, 8 * DAY];
})();

// Grace after the last follow-up before we escalate to a phone call — gives a
// slow supplier a final window to reply by email first (prod ≈ day 10).
// CALLING_ESCALATE_AFTER_MINUTES overrides for testing.
const CALLING_ESCALATE_AFTER_MS: number = (() => {
  const raw = (process.env.CALLING_ESCALATE_AFTER_MINUTES ?? "").trim();
  const mins = Number(raw);
  if (raw && Number.isFinite(mins) && mins >= 0) return mins * MINUTE;
  return 2 * DAY;
})();
const MAX_ESCALATIONS_PER_RUN = 50;
const TERMINAL = new Set(["stale", "closed_declined", "finalized", "price_captured", "escalated_to_calling"]);

type Ctx = { agentId: string | null; runId: string | null; log: (m: string, o?: any) => Promise<void> };
type Admin = ReturnType<typeof createAdminClient>;

function buildFollowupBody(opts: { contactName: string | null; material: string | null; signoff: string; n: number }): string {
  const greeting = opts.contactName ? `Hi ${opts.contactName.split(/\s+/)[0]},` : "Hi there,";
  const mat = opts.material ? ` for ${opts.material}` : "";
  const opener =
    opts.n === 1
      ? `Just following up on my note below — would you be able to share pricing${mat}?`
      : `Circling back one more time on pricing${mat} — I'd still love to get a quote from you.`;
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
  meta: any
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
  const { error: caseErr } = await admin.from("cases").insert({
    org_id: r.org_id,
    type: "calling_escalation",
    status: "open",
    supplier_id: r.supplier_id ?? null,
    material_id: r.material_id ?? null,
    originating_thread_id: r.thread_id ?? null,
    recommended_action: `Call ${supplierName}${materialName ? ` re: ${materialName}` : ""} — no reply after ${FOLLOWUP_DELAYS_MS.length} email follow-ups. Confirm the RFQ was received and the right contact, and request a quote.`,
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
  await ctx.log(`Calling escalation opened for ${supplierName} (no reply after ${FOLLOWUP_DELAYS_MS.length} follow-ups)`, { step: "calling_escalation" });
  return true;
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

  const now = Date.now();
  for (const r of (sent ?? []) as any[]) {
    if (drafted >= MAX_PER_RUN) break;
    const meta = (r.metadata ?? {}) as any;
    const fu = Number(meta.followup_count ?? 0);
    if (TERMINAL.has(meta.flow_status)) continue;

    // Both follow-ups sent and still silent → escalate to a phone call once the
    // grace window has elapsed. Stamped via calling_escalated_at so we only do
    // this once per conversation.
    if (fu >= FOLLOWUP_DELAYS_MS.length) {
      if (meta.calling_escalated_at) continue;
      if (escalated >= MAX_ESCALATIONS_PER_RUN) continue;
      const lastFu = meta.last_followup_at ? new Date(meta.last_followup_at).getTime() : null;
      if (!lastFu || (now - lastFu) < CALLING_ESCALATE_AFTER_MS) continue; // grace not elapsed
      if (await escalateToCalling(ctx, admin, r, meta)) escalated++;
      continue;
    }

    const sentAt = r.reviewed_at ? new Date(r.reviewed_at).getTime() : null;
    if (!sentAt) continue;
    if ((now - sentAt) < FOLLOWUP_DELAYS_MS[fu]) continue; // not due yet

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

    const staged = await stageDraft({
      admin,
      agentId: ctx.agentId,
      runId: ctx.runId,
      orgId: r.org_id,
      supplierId: r.supplier_id,
      materialId: r.material_id,
      to: { name: meta.supplier_name ?? null, address: to },
      subject: (r.subject ?? "").startsWith("Re:") ? r.subject : `Re: ${r.subject ?? "your quote"}`,
      body,
      assignedOperator: r.assigned_operator ?? null,
      emailClient: (r.email_client as "missive" | "rod_app") ?? "missive",
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
      await admin
        .from("draft_references")
        .update({ metadata: { ...meta, followup_count: fu + 1, last_followup_at: new Date().toISOString() } })
        .eq("id", r.id);
      await ctx.log(`No-reply follow-up #${fu + 1} drafted for ${meta.supplier_name ?? to}`, { step: "followup" });
    } else {
      skipped++;
      await ctx.log(`Follow-up stage failed for ${to}: ${staged.error}`, { level: "warn", step: "followup" });
    }
  }

  return { drafted, skipped, escalated };
}
