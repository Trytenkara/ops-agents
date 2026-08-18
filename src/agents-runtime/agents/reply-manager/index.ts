import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { runNoReplyFollowups } from "./no-reply-followup";
import { runStalledFollowups } from "./stalled-followup";
import { runCallTasks } from "./call-tasks";
import { runThreadReconcile } from "./thread-reconcile";

// Agent 15 - Supplier Reply Manager.
//
// Inbound replies are drafted by the Tenkara message.received webhook
// (lib/tenkara-inbound.ts), which classifies the reply, extracts pricing, and
// advances flow_status. What is left for a scheduled agent is the work the
// webhook cannot do, because it fires on a message that never arrived: nudging
// suppliers who went silent on a sent sourcing inquiry (2d and 4d), chasing
// conversations that stalled after the supplier had already replied (3d, 7d and
// 14d from our last message), and raising the interleaved call tasks (1d, 5d).

registerAgent({
  slug: "agent-15-reply-manager",
  displayName: "Agent 15 - Supplier Reply Manager",
  description:
    "Runs the supplier cadence after a sourcing inquiry goes out: no-reply email nudges at 2d and 4d, and call tasks at 1d (intro, always) and 5d (silence only). Reply handling itself lives on the Tenkara inbound webhook. Never sends.",
  async run(ctx) {
    const admin = createAdminClient();

    // Reconcile BEFORE the no-reply sweep: a thread whose reply never reached us
    // (merged in by an operator, or never webhooked because the supplier wrote on
    // a thread our agents had not touched) otherwise reads as silence and gets
    // nudged and escalated to a call while its quote sits unread.
    let reconcile = {
      threadsChecked: 0, replayed: 0, drafted: 0, failed: 0, unreadable: 0,
      mergedShells: 0, superseded: 0, budgetExhausted: false, backlog: 0, oldestDueMinutes: null as number | null,
    };
    let degraded = false;
    try {
      reconcile = await runThreadReconcile(
        { agentId: ctx.agentId, runId: ctx.runId, log: (m, o) => ctx.log(m, o) },
        admin
      );
    } catch (e: any) {
      await ctx.log(`Thread reconciliation failed: ${e?.message ?? e}`, { level: "warn", step: "reconcile" });
      degraded = true;
    }

    let followups = { drafted: 0, skipped: 0, handedOff: 0 };
    try {
      followups = await runNoReplyFollowups(
        { agentId: ctx.agentId, runId: ctx.runId, log: (m, o) => ctx.log(m, o) },
        admin
      );
    } catch (e: any) {
      await ctx.log(`No-reply follow-up sweep failed: ${e?.message ?? e}`, { level: "warn", step: "followup" });
      ctx.setStatus("partial");
      ctx.setSummary(`No-reply sweep failed: ${e?.message ?? e}`);
      return;
    }

    // Suppliers who answered once and then went quiet mid-thread. Isolated from
    // the no-reply sweep above so a failure here costs neither set of nudges.
    let stalled = { drafted: 0, skipped: 0 };
    try {
      stalled = await runStalledFollowups(
        { agentId: ctx.agentId, runId: ctx.runId, log: (m, o) => ctx.log(m, o) },
        admin
      );
    } catch (e: any) {
      await ctx.log(`Stalled-conversation sweep failed: ${e?.message ?? e}`, { level: "warn", step: "stalled_followup" });
      degraded = true;
    }

    // Call tasks run on their own offsets from the RFQ, so a failure here must
    // not cost us the nudges that already drafted above.
    let calls = { raised: 0, skipped: 0 };
    try {
      calls = await runCallTasks(
        { agentId: ctx.agentId, runId: ctx.runId, log: (m, o) => ctx.log(m, o) },
        admin
      );
    } catch (e: any) {
      await ctx.log(`Call task sweep failed: ${e?.message ?? e}`, { level: "warn", step: "call_task" });
      degraded = true;
    }
    ctx.setItemsProcessed(followups.drafted + stalled.drafted + calls.raised + reconcile.drafted);
    ctx.setStatus(degraded ? "partial" : "success");
    ctx.setSummary(
      `Reconcile: ${reconcile.threadsChecked} threads · ${reconcile.replayed} unseen replies replayed · ${reconcile.drafted} drafted` +
        `${reconcile.superseded ? ` · ${reconcile.superseded} superseded` : ""}` +
        `${reconcile.mergedShells ? ` · ${reconcile.mergedShells} merged shells` : ""}` +
        `${reconcile.unreadable ? ` · ${reconcile.unreadable} unreadable` : ""}` +
        `${reconcile.failed ? ` · ${reconcile.failed} failed` : ""}` +
        ` · ${reconcile.backlog} due${reconcile.oldestDueMinutes !== null ? ` (oldest ${reconcile.oldestDueMinutes}m overdue)` : ""}. ` +
        `No-reply sweep: ${followups.drafted} follow-ups · ${followups.handedOff} handed to phone · ${followups.skipped} skipped. ` +
        `Stalled sweep: ${stalled.drafted} follow-ups · ${stalled.skipped} skipped. ` +
        `Call tasks: ${calls.raised} raised · ${calls.skipped} aged out.`
    );
  },
});
