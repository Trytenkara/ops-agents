import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage } from "@/lib/slack";

// Agent 16 — Sourcing Health Watchdog.
//
// Ported from the container-side `sourcing-health-watchdog` skill so it runs on
// Vercel rather than a laptop. Catches the failure modes that silently break
// sourcing while runs still report "success": duplicate-lead loops, agents stuck
// past their lock TTL, materials sourced too thin, enrichment falling behind,
// and sourced-but-never-drafted backlogs.
//
// The checks themselves live in the sourcing_health_report() SQL function
// (migration 0108) because each one needs `having`, `filter`, or `not exists` —
// none of which PostgREST can express.
//
// Read-only: this agent never mutates sourcing data.

const DEFAULT_ORGS = ["Tenkara (Internal Sourcing)", "California Chemicals"];
const MIN_LEADS = Number(process.env.SOURCING_HEALTH_MIN_LEADS ?? 8);
const MIN_CONTACT_FRAC = Number(process.env.SOURCING_HEALTH_MIN_CONTACT_FRAC ?? 0.4);
const STALE_HOURS = Number(process.env.SOURCING_HEALTH_STALE_HOURS ?? 48);
// Enrichment is only "behind" once the oldest raw lead has aged past this.
const ENRICHMENT_LAG_HOURS = 2;

interface Report {
  org: string;
  dup_pairs: number;
  stuck: { slug: string; age_s: number }[];
  thin: { name: string; leads: number }[];
  low_contact: { name: string; settled: number; valid_email: number; with_site: number }[];
  in_progress: number;
  raw_pending: number;
  raw_oldest_hours: number | null;
  undrafted: number;
}

function orgList(): string[] {
  const raw = process.env.SOURCING_HEALTH_ORGS;
  if (!raw) return DEFAULT_ORGS;
  const parsed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_ORGS;
}

// Renders one org's report into the same 🔴/🟡/🟢 lines the Python skill emitted,
// so the Slack output stays recognisable to whoever was reading the old posts.
function render(r: Report): { lines: string[]; alerts: number; warns: number } {
  const alerts: string[] = [];
  const warns: string[] = [];
  const info: string[] = [];

  (r.dup_pairs ? alerts : info).push(
    `duplicate (material,supplier) pairs with >1 active lead: ${r.dup_pairs}`
  );

  for (const s of r.stuck) {
    alerts.push(
      `agent ${s.slug} stuck 'running' — lock expired ${s.age_s}s ago (self-heal reaper not reclaiming)`
    );
  }
  if (!r.stuck.length) info.push("no agents stuck past the lock TTL");

  for (const t of r.thin) {
    warns.push(`THIN material: '${t.name}' has only ${t.leads} suppliers (< ${MIN_LEADS})`);
  }
  for (const l of r.low_contact) {
    warns.push(
      `LOW-CONTACT material: '${l.name}' ${l.valid_email} valid-email / ${l.with_site} site of ${l.settled} settled`
    );
  }
  info.push(`${r.in_progress} materials still enriching (in-progress, not flagged)`);

  if (r.raw_pending && r.raw_oldest_hours && r.raw_oldest_hours > ENRICHMENT_LAG_HOURS) {
    warns.push(
      `enrichment lag: ${r.raw_pending} raw leads, oldest ${r.raw_oldest_hours.toFixed(1)}h — agent-06 behind`
    );
  } else {
    info.push(`enrichment: ${r.raw_pending} raw leads pending (healthy)`);
  }

  if (r.undrafted) {
    warns.push(`${r.undrafted} enriched leads un-drafted > ${STALE_HOURS}h (agent-04 not draining)`);
  }

  return {
    lines: [
      `Sourcing health — org='${r.org}'`,
      ...alerts.map((a) => `🔴 ${a}`),
      ...warns.map((w) => `🟡 ${w}`),
      ...info.map((i) => `🟢 ${i}`),
    ],
    alerts: alerts.length,
    warns: warns.length,
  };
}

registerAgent({
  slug: "agent-16-sourcing-health",
  displayName: "Agent 16 - Sourcing Health Watchdog",
  description:
    "Health-check over the sourcing pipeline: duplicate-lead loops, agents stuck past their lock TTL, thin or low-contact materials, enrichment lag, and undrafted backlogs. Posts a digest to Slack when anything is wrong; never mutates data.",
  async run(ctx) {
    const admin = createAdminClient();
    const orgs = orgList();

    const sections: string[] = [];
    let totalAlerts = 0;
    let totalWarns = 0;
    let checked = 0;

    for (const org of orgs) {
      const { data, error } = await admin.rpc("sourcing_health_report", {
        p_org: org,
        p_min_leads: MIN_LEADS,
        p_min_contact_frac: MIN_CONTACT_FRAC,
        p_stale_hours: STALE_HOURS,
      });
      if (error) {
        await ctx.log(`Health check failed for ${org}: ${error.message}`, {
          level: "error",
          step: "health",
          data: { org },
        });
        continue;
      }

      const report = data as Report;
      const { lines, alerts, warns } = render(report);
      checked += 1;
      totalAlerts += alerts;
      totalWarns += warns;
      sections.push(lines.join("\n"));

      await ctx.log(`${org}: ${alerts} alert(s), ${warns} warning(s)`, {
        level: alerts ? "error" : warns ? "warn" : "info",
        step: "health",
        data: {
          org,
          alerts,
          warns,
          dup_pairs: report.dup_pairs,
          stuck: report.stuck.length,
          thin: report.thin.length,
          low_contact: report.low_contact.length,
          raw_pending: report.raw_pending,
          undrafted: report.undrafted,
        },
      });
    }

    if (!checked) {
      ctx.setStatus("failure");
      ctx.setSummary("No orgs could be checked — every health query errored.");
      return;
    }

    ctx.setItemsProcessed(totalAlerts + totalWarns);
    ctx.setStatus("success");

    const status = totalAlerts ? "🔴 alerts" : totalWarns ? "🟡 warnings" : "🟢 all healthy";
    ctx.setSummary(
      `${checked} org${checked === 1 ? "" : "s"} checked — ${totalAlerts} alert(s), ${totalWarns} warning(s)`
    );

    // Stay quiet when everything is healthy. A daily "all green" post trains
    // people to ignore the channel, which defeats the point of a watchdog.
    if (!totalAlerts && !totalWarns) {
      await ctx.log("All healthy — no Slack post", { step: "slack" });
      return;
    }

    const res = await postSlackMessage({
      channel: process.env.SOURCING_HEALTH_SLACK_CHANNEL,
      text: `*Sourcing health watchdog* — ${status}\n\`\`\`${sections.join("\n\n")}\`\`\``,
    });
    if (!res.ok) {
      await ctx.log(`Slack digest not sent: ${res.error}`, { level: "warn", step: "slack" });
    } else {
      await ctx.log("Posted sourcing health digest to Slack", { step: "slack" });
    }
  },
});
