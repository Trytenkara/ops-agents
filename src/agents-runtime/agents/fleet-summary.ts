import { registerAgent } from "../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage, deepLink } from "@/lib/slack";
import { readQueuedAlerts, markAlertsNotified } from "@/lib/alert-policy";

// Daily 6pm Manila fleet summary — posts to Sam's Slack with yesterday's run totals
// across every agent. Lightweight health check so Sam doesn't have to load the UI.
registerAgent({
  slug: "agent-fleet-summary",
  displayName: "Fleet Summary",
  description: "Daily 6pm summary DM to Sam with run totals and items processed across the fleet over the last 24h.",
  async run(ctx) {
    const admin = createAdminClient();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    const { data: runs } = await admin
      .from("agent_runs")
      .select("status, items_processed, agent_id, agents!agent_runs_agent_id_fkey(name, slug)")
      .gte("run_started_at", since);

    const rows = runs ?? [];
    const succeeded = rows.filter((r: any) => r.status === "success").length;
    const failed = rows.filter((r: any) => r.status === "failure").length;
    const partial = rows.filter((r: any) => r.status === "partial").length;
    const running = rows.filter((r: any) => r.status === "running").length;
    const totalProcessed = rows.reduce((acc: number, r: any) => acc + (r.items_processed ?? 0), 0);

    // Per-agent breakdown
    const perAgent = new Map<string, { name: string; ok: number; bad: number; processed: number }>();
    for (const r of rows as any[]) {
      const slug = r.agents?.slug ?? "unknown";
      const name = r.agents?.name ?? slug;
      const cur = perAgent.get(slug) ?? { name, ok: 0, bad: 0, processed: 0 };
      if (r.status === "success") cur.ok++;
      if (r.status === "failure" || r.status === "partial") cur.bad++;
      cur.processed += r.items_processed ?? 0;
      perAgent.set(slug, cur);
    }

    const breakdown = Array.from(perAgent.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([_, v]) => `  • ${v.name}: ${v.ok} ok${v.bad > 0 ? `, ${v.bad} bad` : ""}${v.processed > 0 ? ` — ${v.processed} processed` : ""}`)
      .join("\n");

    // Drain the queued p2 alerts FIRST and independently of the run summary.
    // These are the only route those alerts have to a human, so they must not sit
    // behind an unrelated Slack post: a bad SAM_SLACK_DM_ID used to return early
    // and silently strand every blocked draft, bounce, and call task.
    let digested = 0;
    let deferred = 0;
    try {
      for (const d of await readQueuedAlerts()) {
        const alertChannel = d.channel ?? process.env.SLACK_ESCALATION_CHANNEL_ID;
        if (!alertChannel) {
          await ctx.log(`${d.named} queued alert(s) but no channel configured; left queued.`, { level: "warn", step: "alerts" });
          continue;
        }
        const alertText = [
          `:inbox_tray: *Needs a human*: ${d.named} item${d.named === 1 ? "" : "s"} the fleet raised since the last digest`,
          "",
          ...d.sections.flatMap((s) => [`*${s.group}*`, ...s.lines.map((l) => `  • ${l}`), ""]),
          `Control Room: ${deepLink("/agents/health")}`,
        ].join("\n");
        const alertRes = await postSlackMessage({ channel: alertChannel, text: alertText });
        if (alertRes.ok) {
          await markAlertsNotified(d.keys);
          digested += d.named;
          deferred += d.deferred;
          await ctx.log(`Posted alert digest to ${alertChannel}: ${d.named} named, ${d.deferred} carried over.`, { step: "alerts" });
        } else {
          await ctx.log(`Alert digest post to ${alertChannel} failed: ${alertRes.error}; left queued.`, { level: "error", step: "alerts" });
        }
      }
    } catch (e: any) {
      await ctx.log(`Alert digest pass failed (non-fatal): ${e?.message ?? e}`, { level: "error", step: "alerts" });
    }

    const channel = process.env.SAM_SLACK_DM_ID ?? process.env.SLACK_ESCALATION_CHANNEL_ID;
    if (!channel) {
      await ctx.log("No SAM_SLACK_DM_ID/SLACK_ESCALATION_CHANNEL_ID configured; skipping run summary.", { level: "warn" });
      ctx.setSummary(`Run summary skipped (no Slack channel)${digested ? `; ${digested} alerts digested` : ""}.`);
      ctx.setStatus("success");
      return;
    }

    const text = [
      ":bar_chart: *Tackle Box daily summary* (last 24h)",
      `*${rows.length}* runs — :white_check_mark: ${succeeded}  :warning: ${partial}  :x: ${failed}${running > 0 ? `  :hourglass_flowing_sand: ${running} still running` : ""}`,
      `*${totalProcessed}* items processed across the fleet`,
      "",
      breakdown || "_(no runs in window)_",
      "",
      `Dashboard: ${deepLink("/agents/health")}`,
    ].join("\n");

    const res = await postSlackMessage({ channel, text });
    if (!res.ok) {
      await ctx.log(`Slack post failed: ${res.error}`, { level: "error", step: "slack" });
      ctx.setStatus("partial");
      ctx.setSummary(`Slack post failed: ${res.error}${digested ? `; ${digested} alerts digested` : ""}`);
      return;
    }

    ctx.setItemsProcessed(rows.length);
    ctx.setSummary(
      `Posted summary: ${rows.length} runs, ${totalProcessed} items` +
        (digested ? ` · ${digested} alert(s) digested` : "") +
        (deferred ? ` · ${deferred} carried to the next digest` : "")
    );
    ctx.setStatus("success");
  },
});
