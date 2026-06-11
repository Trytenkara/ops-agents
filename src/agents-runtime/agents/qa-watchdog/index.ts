import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage, deepLink } from "@/lib/slack";

// Agent 14 — QA Watchdog.
//
// A data-integrity sweep over the other agents' outputs. It does NOT fix data —
// it checks that things landed properly and calls out issues so ops can act.
// Checks (all OA-side, read-only on Tenkara):
//   1. Replies detected but never drafted — email-scanner saw a supplier reply
//      but the reply draft failed to stage (reply_detected set, reply_draft not).
//   2. Staged quotes missing required data — pending rows with no price, no
//      material name, or an unresolved material_id/supplier_id.
//   3. Low-confidence staged quotes waiting on review.
//   4. Findings/quotes stuck in review past STALE_DAYS.
//   5. Agent runs that failed in the last day.
//
// Output: a tally on the run summary + a Slack digest when anything is wrong.

const STALE_DAYS = 7;
const FAILURE_LOOKBACK_HOURS = 24;

interface Issue {
  key: string;
  label: string;
  count: number;
  detail?: string;
  link?: string;
}

registerAgent({
  slug: "agent-14-qa-watchdog",
  displayName: "Agent 14 - QA Watchdog",
  description:
    "Data-integrity sweep over the other agents' outputs: replies detected but not drafted, staged quotes missing price/material, low-confidence or stale review items, and recent agent failures. Flags issues to Slack; never mutates data.",
  async run(ctx) {
    const admin = createAdminClient();
    const issues: Issue[] = [];
    const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 3600 * 1000).toISOString();

    // 1. Replies detected but not drafted.
    try {
      const { data: refs } = await admin
        .from("draft_references")
        .select("id, metadata")
        .neq("status", "discarded")
        .not("metadata->reply_detected", "is", null);
      const undrafted = (refs ?? []).filter(
        (r: any) => r.metadata?.reply_detected && !r.metadata?.reply_draft
      );
      if (undrafted.length) {
        issues.push({
          key: "replies_undrafted",
          label: "Supplier replies detected but no reply draft staged",
          count: undrafted.length,
          detail: "Email Scanner saw the reply but drafting failed — operator has no draft to review.",
          link: deepLink("/work/leads"),
        });
      }
    } catch (e: any) {
      await ctx.log(`check replies_undrafted failed: ${e?.message ?? e}`, { level: "warn", step: "check" });
    }

    // 2/3/4. Staged-quote integrity (only if the table exists / has rows).
    try {
      const { data: staged } = await admin
        .from("staged_quotes")
        .select("id, price, material_name, material_id, supplier_id, confidence, status, created_at")
        .eq("status", "pending_review");
      const rows = staged ?? [];
      const missingData = rows.filter(
        (r: any) => r.price == null || !r.material_name || !r.material_id || !r.supplier_id
      );
      const lowConfidence = rows.filter(
        (r: any) => r.confidence === "low" || r.confidence === "needs_review"
      );
      const stale = rows.filter((r: any) => r.created_at && r.created_at < staleCutoff);
      if (missingData.length) {
        issues.push({
          key: "staged_missing_data",
          label: "Staged quotes missing price / material / supplier link",
          count: missingData.length,
          detail: "Extracted from email/attachment but not yet usable — needs ops to fill in before CSV export.",
          link: deepLink("/work/review/staged-quotes"),
        });
      }
      if (lowConfidence.length) {
        issues.push({
          key: "staged_low_confidence",
          label: "Low-confidence staged quotes awaiting review",
          count: lowConfidence.length,
          link: deepLink("/work/review/staged-quotes"),
        });
      }
      if (stale.length) {
        issues.push({
          key: "staged_stale",
          label: `Staged quotes pending review > ${STALE_DAYS}d`,
          count: stale.length,
          link: deepLink("/work/review/staged-quotes"),
        });
      }
    } catch (e: any) {
      await ctx.log(`check staged_quotes failed: ${e?.message ?? e}`, { level: "warn", step: "check" });
    }

    // 4b. Marketplace findings stuck in review.
    try {
      const { count } = await admin
        .from("marketplace_check_findings")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending_review")
        .lt("created_at", staleCutoff);
      if (count && count > 0) {
        issues.push({
          key: "marketplace_stale",
          label: `Marketplace price findings pending review > ${STALE_DAYS}d`,
          count,
          link: deepLink("/work/review/marketplace"),
        });
      }
    } catch (e: any) {
      await ctx.log(`check marketplace_stale failed: ${e?.message ?? e}`, { level: "warn", step: "check" });
    }

    // 5. Recent agent failures.
    try {
      const failCutoff = new Date(Date.now() - FAILURE_LOOKBACK_HOURS * 3600 * 1000).toISOString();
      const { data: fails } = await admin
        .from("agent_runs")
        .select("agent_id, status, summary, run_started_at")
        .eq("status", "failure")
        .gte("run_started_at", failCutoff);
      if (fails && fails.length) {
        issues.push({
          key: "agent_failures",
          label: `Agent runs failed in the last ${FAILURE_LOOKBACK_HOURS}h`,
          count: fails.length,
          detail: fails
            .slice(0, 5)
            .map((f: any) => `• ${f.summary ?? "(no summary)"}`)
            .join("\n"),
          link: deepLink("/agents/health"),
        });
      }
    } catch (e: any) {
      await ctx.log(`check agent_failures failed: ${e?.message ?? e}`, { level: "warn", step: "check" });
    }

    const totalIssues = issues.reduce((n, i) => n + i.count, 0);
    for (const i of issues) {
      await ctx.log(`${i.label}: ${i.count}`, { step: "issue", data: { key: i.key, count: i.count } });
    }

    ctx.setItemsProcessed(totalIssues);
    ctx.setStatus("success");

    if (issues.length === 0) {
      ctx.setSummary("All clear — no data-integrity issues found.");
      return;
    }

    ctx.setSummary(
      `${totalIssues} issue${totalIssues === 1 ? "" : "s"} across ${issues.length} check${issues.length === 1 ? "" : "s"}: ` +
        issues.map((i) => `${i.label} (${i.count})`).join(" · ")
    );

    // Slack digest.
    const blocks: any[] = [
      { type: "header", text: { type: "plain_text", text: `🩺 QA Watchdog — ${totalIssues} issue${totalIssues === 1 ? "" : "s"}` } },
    ];
    for (const i of issues) {
      let text = `*${i.label}* — *${i.count}*`;
      if (i.detail) text += `\n${i.detail}`;
      if (i.link) text += `\n<${i.link}|Review>`;
      blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    }
    const res = await postSlackMessage({
      text: `QA Watchdog: ${totalIssues} data-integrity issue(s) need attention`,
      blocks,
    });
    if (!res.ok) {
      await ctx.log(`Slack digest not sent: ${res.error}`, { level: "warn", step: "slack" });
    } else {
      await ctx.log("Posted QA digest to Slack", { step: "slack" });
    }
  },
});
