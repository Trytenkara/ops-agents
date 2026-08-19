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

    // The queued alerts and the run summary go out as ONE post (COMM-06). The
    // alert lines lead, because they are the only route those alerts have to a
    // human; the fleet numbers are context underneath them. Alerts are marked
    // notified only after Slack accepts the post, so a failure leaves every
    // blocked draft, bounce and call task queued for tomorrow rather than
    // losing them.
    let digested = 0;
    let deferred = 0;
    let alertKeys: string[] = [];
    let alertLines: string[] = [];
    try {
      for (const d of await readQueuedAlerts()) {
        alertKeys = d.keys;
        digested = d.named;
        deferred = d.deferred;
        alertLines = [
          `:inbox_tray: *Needs a human*: ${d.named} item${d.named === 1 ? "" : "s"} the fleet raised since the last digest`,
          "",
          ...d.sections.flatMap((s) => [`*${s.group}*`, ...s.lines.map((l) => `  • ${l}`), ""]),
        ];
      }
    } catch (e: any) {
      await ctx.log(`Alert digest read failed (non-fatal): ${e?.message ?? e}`, { level: "error", step: "alerts" });
    }

    const text = [
      ...alertLines,
      ":bar_chart: *Tackle Box daily summary* (last 24h)",
      `*${rows.length}* runs — :white_check_mark: ${succeeded}  :warning: ${partial}  :x: ${failed}${running > 0 ? `  :hourglass_flowing_sand: ${running} still running` : ""}`,
      `*${totalProcessed}* items processed across the fleet`,
      "",
      breakdown || "_(no runs in window)_",
      "",
      `Dashboard: ${deepLink("/agents/health")}`,
    ].join("\n");

    const res = await postSlackMessage({ text });
    if (res.ok && alertKeys.length) {
      await markAlertsNotified(alertKeys);
      await ctx.log(`Digest posted: ${digested} named, ${deferred} carried over.`, { step: "alerts" });
    } else if (!res.ok && alertKeys.length) {
      await ctx.log(`Digest post failed: ${res.error}; ${digested} alert(s) left queued.`, { level: "error", step: "alerts" });
    }
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
