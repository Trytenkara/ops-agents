import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { runNoReplyFollowups } from "./no-reply-followup";

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
    ctx.setItemsProcessed(followups.drafted + followups.escalated);
    ctx.setStatus("success");
    ctx.setSummary(
      `No-reply sweep: ${followups.drafted} follow-ups · ${followups.escalated} calling-escalations · ${followups.skipped} skipped.`
    );
  },
});
