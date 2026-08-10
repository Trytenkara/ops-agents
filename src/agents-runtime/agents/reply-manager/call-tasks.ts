import { callTaskDelaysMs } from "@/lib/agent-timing";
import { loadOrgStatuses, outreachAllowed } from "@/lib/org-status";
import type { createAdminClient } from "@/lib/supabase/admin";
import { buildCallBrief } from "@/lib/call-brief";
import { CallOperatorResolver, notifyCallEscalation } from "@/lib/call-escalation";
import { loadThreadState } from "./no-reply-followup";

// Scheduled call tasks (part of Agent 15). The live cadence interleaves email and
// phone rather than treating a call as the thing that happens once email has
// failed:
//
//   day 0  sourcing inquiry (Agent 04)   day 1  call task #1  (intro, always)
//   day 2  nudge #1                      day 5  call task #2  (silence only)
//   day 4  nudge #2
//
// Stage 1 fires whether or not the supplier replied. It is an intro call while
// the inquiry is still warm, and a supplier who wrote back is exactly the one
// worth phoning. Every later stage is silence-only: once they are talking to us
// by email, a "we haven't heard from you" call is noise.
//
// Offsets are per-org (lib/agent-timing.ts), all measured from the day the
// sourcing inquiry was sent, so a slow operator sending nudges late cannot drag
// the phone work out with it.

type Ctx = { agentId: string | null; runId: string | null; log: (m: string, o?: any) => Promise<void> };
type Admin = ReturnType<typeof createAdminClient>;

const MAX_PER_RUN = 50;

// Stages already raised on a conversation, stamped on the outreach draft so a
// task is never raised twice. Skipped stages are recorded here too, since an intro
// call that came due while the org was paused is not owed retroactively.
const STAGE_KEY = "call_task_stages";

// A stage that came due long ago is dropped rather than raised. Without this,
// shipping the cadence (or unpausing an org) would deal every in-flight thread a
// day-1 "intro call" at once, weeks after the inquiry went out. The window is the
// full cadence span, so it scales with the compressed test offsets too.
function graceMs(delays: number[]): number {
  return delays[delays.length - 1] ?? 0;
}

// Don't stack a second call task on a supplier whose first one is still sitting
// unworked. The stage stays unstamped so it is reconsidered next run, and ages
// out on its own if the first call is never made.
async function hasOpenCallTask(admin: Admin, r: any): Promise<boolean> {
  const { data } = await admin
    .from("cases")
    .select("id")
    .eq("org_id", r.org_id)
    .eq("type", "calling_escalation")
    .in("status", ["open", "in_progress"])
    .eq("supplier_id", r.supplier_id ?? "")
    .eq("material_id", r.material_id ?? "")
    .maybeSingle();
  return !!data;
}

async function raiseCallTask(
  ctx: Ctx,
  admin: Admin,
  r: any,
  meta: any,
  opts: {
    resolver: CallOperatorResolver;
    stage: number;
    replied: boolean;
    followupsSent: number;
    followupSentAt: string[];
  }
): Promise<boolean> {
  const supplierName = meta.supplier_name ?? r.supplier_id ?? "supplier";
  const materialName = meta.material_name ?? null;
  const reason = opts.replied
    ? "replied by email, scheduled intro call"
    : opts.stage === 1
      ? "scheduled intro call the day after the sourcing inquiry"
      : opts.followupsSent > 0
        ? `no reply after ${opts.followupsSent} email follow-up${opts.followupsSent === 1 ? "" : "s"}`
        : "no reply to the initial sourcing inquiry";

  const brief = await buildCallBrief(admin as any, {
    orgId: r.org_id,
    supplierId: r.supplier_id ?? null,
    meta,
    subject: r.subject ?? null,
    threadId: r.thread_id ?? null,
    inquirySentAt: r.reviewed_at ?? null,
    followupSentAt: opts.followupSentAt,
    followupsSent: opts.followupsSent,
    callStage: opts.stage,
    replied: opts.replied,
  });

  // Route it across the client's call operators, not the draft's email owner.
  const routing = await opts.resolver.route({
    orgId: r.org_id,
    assignedOperator: r.assigned_operator ?? null,
    supplierId: r.supplier_id ?? null,
    supplierName: meta.supplier_name ?? null,
  });

  const phoneLine = brief.contact.phone ? ` on ${brief.contact.phone}` : " (no number on file, find one first)";
  const { error: caseErr } = await admin.from("cases").insert({
    org_id: r.org_id,
    type: "calling_escalation",
    status: "open",
    supplier_id: r.supplier_id ?? null,
    material_id: r.material_id ?? null,
    originating_thread_id: r.thread_id ?? null,
    recommended_action: `Call ${supplierName}${phoneLine}${materialName ? ` re: ${materialName}` : ""}, ${reason}. Confirm the sourcing inquiry was received and the right contact, and request a quote.`,
    assigned_operator: routing.caller?.userId ?? null,
    metadata: {
      source_agent: "agent-15-reply-manager",
      source_run_id: ctx.runId,
      reason: opts.replied ? "scheduled_intro_call_replied" : opts.stage === 1 ? "scheduled_intro_call" : "no_reply_after_followups",
      call_stage: opts.stage,
      draft_reference_id: r.id,
      thread_id: r.thread_id ?? null,
      followup_count: opts.followupsSent,
      last_followup_at: meta.last_followup_at ?? null,
      supplier_name: meta.supplier_name ?? null,
      supplier_contact_email: meta.supplier_contact_email ?? null,
      material_name: materialName,
      lead_id: brief.leadId,
      call_brief: brief,
    },
  });
  if (caseErr) {
    await ctx.log(`Call task insert failed for ${supplierName}: ${caseErr.message}`, { level: "warn", step: "call_task" });
    return false;
  }

  const [orgSlug, orgName] = await Promise.all([
    opts.resolver.orgSlug(r.org_id),
    opts.resolver.orgName(r.org_id),
  ]);
  await notifyCallEscalation({ brief, routing, orgName, orgSlug, reason, origin: "agent" });

  await ctx.log(
    `Call task #${opts.stage} opened for ${supplierName} (${reason})${routing.caller ? `, assigned to ${routing.caller.name ?? routing.caller.email}` : ", unassigned: no call operator for this client"}${brief.contact.phone ? "" : ", no phone on file"}`,
    { step: "call_task" }
  );
  return true;
}

export async function runCallTasks(ctx: Ctx, admin: Admin): Promise<{ raised: number; skipped: number }> {
  let raised = 0;
  let skipped = 0;

  // Only Agent 04's initial cold outreach carries the cadence, not re-quotes
  // (Agent 02) or reply responses (Agent 15 itself).
  const { data: a4 } = await admin.from("agents").select("id").eq("slug", "agent-04-outreach").maybeSingle();
  if (!a4?.id) {
    await ctx.log("call tasks: agent-04-outreach not found, skipping", { step: "call_task" });
    return { raised, skipped };
  }

  // Unlike the nudge sweep this cannot filter on reply_detected: stage 1 fires
  // for suppliers who replied too.
  const { data: sent } = await admin
    .from("draft_references")
    .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata, thread_id, reviewed_at")
    .eq("agent_id", a4.id)
    .eq("status", "sent")
    .not("reviewed_at", "is", null)
    .limit(300);

  const orgStatuses = await loadOrgStatuses(admin);
  const { followups: followupsByThread, replied: repliedThreads } = await loadThreadState(
    admin,
    Array.from(new Set(((sent ?? []) as any[]).map((r) => r.thread_id).filter(Boolean)))
  );

  const now = Date.now();
  const resolver = new CallOperatorResolver(admin as any);

  for (const r of (sent ?? []) as any[]) {
    if (raised >= MAX_PER_RUN) break;
    const meta = (r.metadata ?? {}) as any;
    if (!outreachAllowed(orgStatuses.byOaId.get(r.org_id) ?? "off")) continue;
    if (!r.thread_id) continue;

    const sentAt = r.reviewed_at ? new Date(r.reviewed_at).getTime() : null;
    if (!sentAt) continue;

    const delays = callTaskDelaysMs(r.org_id);
    const done: number[] = Array.isArray(meta[STAGE_KEY]) ? meta[STAGE_KEY] : [];
    const replied = repliedThreads.has(r.thread_id);

    // Earliest stage that is due and hasn't been dealt with. One per row per run;
    // a backlog drains over subsequent ticks rather than dealing a supplier two
    // call tasks at once.
    const idx = delays.findIndex((d, i) => !done.includes(i + 1) && now >= sentAt + d);
    if (idx < 0) continue;
    const stage = idx + 1;

    // Past its useful life, or superseded by a reply on a silence-only stage.
    // Either way the stage is closed out so it stops being reconsidered.
    const expired = now > sentAt + delays[idx] + graceMs(delays);
    const supersededByReply = stage > 1 && replied;
    if (expired || supersededByReply) {
      await admin
        .from("draft_references")
        .update({ metadata: { ...meta, [STAGE_KEY]: [...done, stage] } })
        .eq("id", r.id);
      skipped++;
      continue;
    }

    if (await hasOpenCallTask(admin, r)) continue;

    const acted = (followupsByThread.get(r.thread_id) ?? []).filter((d) => d.status === "sent");
    const followupSentAt = acted
      .map((d) => (d.reviewed_at ?? d.created_at) as string)
      .filter(Boolean)
      .sort();

    const ok = await raiseCallTask(ctx, admin, r, meta, {
      resolver,
      stage,
      replied,
      followupsSent: acted.length,
      followupSentAt,
    });
    if (!ok) continue;

    await admin
      .from("draft_references")
      .update({ metadata: { ...meta, [STAGE_KEY]: [...done, stage] } })
      .eq("id", r.id);
    raised++;
  }

  return { raised, skipped };
}
