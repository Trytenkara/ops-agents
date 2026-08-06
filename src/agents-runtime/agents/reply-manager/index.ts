import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { runNoReplyFollowups } from "./no-reply-followup";
import { runThreadReconcile } from "./thread-reconcile";

// Agent 15 - Supplier Reply Manager.
//
// Inbound replies are drafted by the Tenkara message.received webhook
// (lib/tenkara-inbound.ts), which classifies the reply, extracts pricing, and
// advances flow_status. What is left for a scheduled agent is the sweep the
// webhook cannot do, because it fires on a message that never arrived: nudging
// suppliers who went silent on a sent sourcing inquiry (4d and 8d), then
// escalating to a call.

registerAgent({
  slug: "agent-15-reply-manager",
  displayName: "Agent 15 - Supplier Reply Manager",
  description:
    "Drafts no-reply follow-ups for suppliers who went silent on a sent sourcing inquiry (at 4d and 8d), then escalates to a Case for a call. Reply handling itself lives on the Tenkara inbound webhook. Never sends.",
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

    let followups = { drafted: 0, skipped: 0, escalated: 0 };
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
    ctx.setItemsProcessed(followups.drafted + followups.escalated + reconcile.drafted);
    ctx.setStatus(degraded ? "partial" : "success");
    ctx.setSummary(
      `Reconcile: ${reconcile.threadsChecked} threads · ${reconcile.replayed} unseen replies replayed · ${reconcile.drafted} drafted` +
        `${reconcile.superseded ? ` · ${reconcile.superseded} superseded` : ""}` +
        `${reconcile.mergedShells ? ` · ${reconcile.mergedShells} merged shells` : ""}` +
        `${reconcile.unreadable ? ` · ${reconcile.unreadable} unreadable` : ""}` +
        `${reconcile.failed ? ` · ${reconcile.failed} failed` : ""}` +
        ` · ${reconcile.backlog} due${reconcile.oldestDueMinutes !== null ? ` (oldest ${reconcile.oldestDueMinutes}m overdue)` : ""}. ` +
        `No-reply sweep: ${followups.drafted} follow-ups · ${followups.escalated} calling-escalations · ${followups.skipped} skipped.`
    );
  },
});
