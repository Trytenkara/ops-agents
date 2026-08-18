import { stageDraft } from "@/lib/draft-staging";
import { stalledFollowupDelaysMs } from "@/lib/agent-timing";
import { loadOrgStatuses, outreachAllowed } from "@/lib/org-status";
import type { createAdminClient } from "@/lib/supabase/admin";

// Stalled-conversation follow-ups (part of Agent 15).
//
// The no-reply sweep next door only chases suppliers who never answered the
// original inquiry: one reply anywhere on the thread disqualifies it forever.
// So a supplier who wrote back, traded a few emails and then went quiet got
// nothing — not another email, not even the day-5 call, which is also
// suppressed by a reply. This sweep covers that gap: every outbound message we
// send is chased if it goes unanswered, and the only thing that ends the
// sequence is a genuine ending (they declined, we finished, or our own last
// message closed the conversation out).
//
// Nudges are measured from OUR last outbound message, not from the original
// inquiry, so the clock restarts every time the conversation moves.

const MAX_PER_RUN = 50;
const LOOKBACK_DAYS = 120;

// A staged draft the operator hasn't acted on yet pauses the sequence — chasing
// silence is a lie while our own last message is still sitting in the outbox.
const PENDING_DRAFT_STATUS = new Set(["staged", "reviewed"]);

// Real endings. Note "stale" is deliberately absent: that is our own 8-turn cap
// firing on a busy thread, not the supplier saying goodbye, and those are
// exactly the live negotiations ops don't want dropped.
const TERMINAL = new Set(["closed_declined", "finalized", "price_captured"]);

type Ctx = { agentId: string | null; runId: string | null; log: (m: string, o?: any) => Promise<void> };
type Admin = ReturnType<typeof createAdminClient>;

function buildStalledBody(opts: { contactName: string | null; material: string | null; signoff: string; n: number }): string {
  const greeting = opts.contactName ? `Hi ${opts.contactName.split(/\s+/)[0]},` : "Hi there,";
  const mat = opts.material ? ` on ${opts.material}` : "";
  const opener =
    opts.n === 1
      ? `Following up on our exchange${mat} below. Did you get a chance to look at my last note?`
      : opts.n === 2
        ? `Checking in again${mat}. I know things get busy, so just flagging that we're still waiting on your side.`
        : `Last check-in from me${mat}. If the timing isn't right, no problem at all, just let me know and I'll close this out.`;
  return [
    greeting,
    "",
    `${opener} Happy to resend anything or answer questions if that helps move it along.`,
    "",
    "Thanks,",
    opts.signoff,
  ].join("\n");
}

type ThreadState = {
  lastOutboundAt: number;
  lastInboundAt: number;
  terminal: boolean;
  conversationComplete: boolean;
  awaitingOperator: boolean;
  priorNudges: number;
  anchor: any | null; // the most recent sent row, whose metadata we reply from
  // Our reply drafts don't all carry the supplier's address, so the newest
  // message on a thread is often not the one that knows where to write. Take it
  // from anywhere on the thread rather than declaring the supplier unreachable.
  contactEmail: string | null;
};

// Paged to completion: a flat .limit() here silently drops whole conversations
// from the sweep, and a supplier we simply never scanned looks identical to one
// we decided not to chase.
export async function loadRecentThreadIds(admin: Admin): Promise<string[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const ids = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("draft_references")
      .select("thread_id")
      .not("thread_id", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as any[];
    for (const r of rows) ids.add(r.thread_id);
    if (rows.length < PAGE) break;
  }
  return Array.from(ids);
}

export async function loadStalledThreadState(admin: Admin, threadIds: string[]): Promise<Map<string, ThreadState>> {
  const byThread = new Map<string, ThreadState>();
  for (let i = 0; i < threadIds.length; i += 100) {
    const { data } = await admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, subject, assigned_operator, status, reviewed_at, created_at, metadata, thread_id")
      .in("thread_id", threadIds.slice(i, i + 100));
    for (const d of (data ?? []) as any[]) {
      if (!d.thread_id) continue;
      let t = byThread.get(d.thread_id);
      if (!t) {
        t = { lastOutboundAt: 0, lastInboundAt: 0, terminal: false, conversationComplete: false, awaitingOperator: false, priorNudges: 0, anchor: null, contactEmail: null };
        byThread.set(d.thread_id, t);
      }
      const meta = (d.metadata ?? {}) as any;
      if (!t.contactEmail && typeof meta.supplier_contact_email === "string") t.contactEmail = meta.supplier_contact_email;
      if (TERMINAL.has(meta.flow_status)) t.terminal = true;
      if (PENDING_DRAFT_STATUS.has(d.status)) t.awaitingOperator = true;

      const detected = meta.reply_detected?.detected_at;
      if (detected) {
        const ts = new Date(detected).getTime();
        if (Number.isFinite(ts) && ts > t.lastInboundAt) t.lastInboundAt = ts;
      }

      if (d.status !== "sent") continue;
      const ts = new Date(d.reviewed_at ?? d.created_at).getTime();
      if (!Number.isFinite(ts)) continue;
      // Only a SENT closing message ends things; one the operator discarded doesn't.
      if (meta.conversation_complete) t.conversationComplete = true;
      if (meta.draft_kind === "stalled_followup") t.priorNudges++;
      if (ts > t.lastOutboundAt) {
        t.lastOutboundAt = ts;
        t.anchor = d;
      }
    }
  }
  return byThread;
}

export async function runStalledFollowups(ctx: Ctx, admin: Admin): Promise<{ drafted: number; skipped: number }> {
  let drafted = 0;
  let skipped = 0;

  const threadIds = await loadRecentThreadIds(admin);
  if (!threadIds.length) return { drafted, skipped };

  const state = await loadStalledThreadState(admin, threadIds);
  const orgStatuses = await loadOrgStatuses(admin);
  const now = Date.now();

  for (const [threadId, t] of state) {
    if (drafted >= MAX_PER_RUN) break;
    // No reply ever: the no-reply sweep owns this thread, and running both would
    // double-nudge the same supplier.
    if (!t.lastInboundAt) continue;
    if (t.terminal || t.conversationComplete || t.awaitingOperator) continue;
    if (!t.anchor || !t.lastOutboundAt) continue;
    // Their message is newer than ours — we owe them a reply, not a chase.
    if (t.lastInboundAt > t.lastOutboundAt) continue;

    const r = t.anchor;
    const meta = (r.metadata ?? {}) as any;
    if (!outreachAllowed(orgStatuses.byOaId.get(r.org_id) ?? "off")) continue;

    const delays = stalledFollowupDelaysMs(r.org_id);
    if (t.priorNudges >= delays.length) continue;
    if (now < t.lastOutboundAt + delays[t.priorNudges]) continue;

    const to = (meta.supplier_contact_email as string | undefined) ?? t.contactEmail ?? undefined;
    if (!to) {
      skipped++;
      continue;
    }

    const n = t.priorNudges + 1;
    const staged = await stageDraft({
      admin,
      agentId: ctx.agentId,
      runId: ctx.runId,
      orgId: r.org_id,
      supplierId: r.supplier_id,
      materialId: r.material_id,
      to: { name: meta.supplier_name ?? null, address: to },
      subject: (r.subject ?? "").startsWith("Re:") ? r.subject : `Re: ${r.subject ?? "your quote"}`,
      body: buildStalledBody({
        contactName: meta.supplier_name ?? null,
        material: meta.material_name ?? null,
        signoff: meta.suggested_signoff ?? meta.ghost_brand ?? "Sourcing Team",
        n,
      }),
      assignedOperator: r.assigned_operator ?? null,
      conversationId: threadId,
      metadata: {
        outreach_mode: meta.outreach_mode ?? "ghost",
        ghost_brand: meta.ghost_brand ?? null,
        supplier_contact_email: to,
        supplier_name: meta.supplier_name ?? null,
        material_name: meta.material_name ?? null,
        draft_kind: "stalled_followup",
        stalled_followup_n: n,
        staged_via: "agent-15-stalled-followup",
      },
    });

    if (staged.ok) {
      drafted++;
      await ctx.log(`Stalled-conversation follow-up #${n} drafted for ${meta.supplier_name ?? to}`, { step: "stalled_followup" });
    } else {
      skipped++;
      await ctx.log(`Stalled follow-up stage failed for ${to}: ${staged.error}`, { level: "warn", step: "stalled_followup" });
    }
  }

  return { drafted, skipped };
}
