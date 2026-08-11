import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage } from "@/lib/slack";
import { shouldPostDigest, recordDigestPosted } from "@/lib/alert-policy";

type Admin = ReturnType<typeof createAdminClient>;

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

// A discovery source that has gone dark. Nothing else in the fleet catches this:
// SourceReady is ~51% of every lead ever staged and produced zero for two days
// (2026-08-08 to 08-10) while every run reported success, because the upstream
// returned its failure as an ordinary empty-looking result and the adapter read
// it as "no results". Per-material checks can't see it either — a thin material
// looks the same whether one source died or the market really is small. Compared
// against the source's OWN trailing baseline so no source list needs maintaining.
const SOURCE_DARK_HOURS = Number(process.env.SOURCING_HEALTH_SOURCE_DARK_HOURS ?? 24);
const SOURCE_BASELINE_DAYS = Number(process.env.SOURCING_HEALTH_SOURCE_BASELINE_DAYS ?? 7);
const DISCOVERY_SOURCES = ["sourceready", "importyeti", "ai_discovery"];

// Breadth: how many suppliers a material is supposed to end up with, and how
// long it may sit below that before the shortfall is a defect rather than a
// material still ramping. The `thin` check above cannot serve this purpose — it
// exempts any material holding raw leads, which every new material does, and it
// triggers at 8 rather than the real target. See migration 0113.
const BREADTH_TARGET = Number(process.env.SOURCING_HEALTH_BREADTH_TARGET ?? 100);
const BREADTH_MIN_AGE_HOURS = Number(process.env.SOURCING_HEALTH_BREADTH_MIN_AGE_HOURS ?? 12);
// Below this fraction of the target the shortfall is an alert, not a warning: a
// material at 7 of 100 is not "a bit thin", it is a material nobody can source
// from. Above it, the material is workable and just wants more breadth.
const BREADTH_ALERT_FRAC = Number(process.env.SOURCING_HEALTH_BREADTH_ALERT_FRAC ?? 0.25);

async function countLeads(admin: Admin, source: string, sinceIso: string, untilIso?: string) {
  let q = admin
    .from("leads_in_flight")
    .select("id", { count: "exact", head: true })
    .eq("source", source)
    .gte("created_at", sinceIso);
  if (untilIso) q = q.lt("created_at", untilIso);
  const { count, error } = await q;
  if (error) throw new Error(`${source}: ${error.message}`);
  return count ?? 0;
}

// A source is dark when it staged nothing in the recent window but was
// demonstrably producing in the window before it. A source that is legitimately
// switched off goes quiet in both windows and is therefore never flagged.
async function darkSources(admin: Admin): Promise<{ source: string; baseline: number }[]> {
  const now = Date.now();
  const recentFrom = new Date(now - SOURCE_DARK_HOURS * 3600_000).toISOString();
  const baseFrom = new Date(now - (SOURCE_BASELINE_DAYS * 24 + SOURCE_DARK_HOURS) * 3600_000).toISOString();
  const out: { source: string; baseline: number }[] = [];
  for (const source of DISCOVERY_SOURCES) {
    const recent = await countLeads(admin, source, recentFrom);
    if (recent > 0) continue;
    const baseline = await countLeads(admin, source, baseFrom, recentFrom);
    if (baseline > 0) out.push({ source, baseline });
  }
  return out;
}

interface Report {
  org: string;
  dup_pairs: number;
  stuck: { slug: string; age_s: number }[];
  thin: { name: string; leads: number }[];
  low_contact: { name: string; settled: number; valid_email: number; with_site: number }[];
  in_progress: number;
  breadth_stalled: { name: string; leads: number; age_h: number }[];
  breadth_stalled_count: number;
  breadth_worst_leads: number | null;
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

  // Named window, never a silent truncation: the count is the whole set, the
  // list is the worst 10 of it.
  const stalled = r.breadth_stalled ?? [];
  if (stalled.length) {
    const worst = stalled
      .map((m) => `'${m.name}' ${m.leads} (${Math.round(m.age_h)}h)`)
      .join(", ");
    const shown = stalled.length < r.breadth_stalled_count
      ? `worst ${stalled.length} of ${r.breadth_stalled_count}`
      : `all ${r.breadth_stalled_count}`;
    const line =
      `BREADTH: ${r.breadth_stalled_count} material(s) below the ${BREADTH_TARGET}-supplier target ` +
      `after ${BREADTH_MIN_AGE_HOURS}h — ${shown}: ${worst}`;
    const critical = (r.breadth_worst_leads ?? BREADTH_TARGET) < BREADTH_TARGET * BREADTH_ALERT_FRAC;
    (critical ? alerts : warns).push(line);
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

// Fingerprint the CONDITIONS, not the rendered lines. `age_s` and
// `raw_oldest_hours` climb every run, so hashing the text meant the dedupe never
// fired in exactly the case it exists for: a problem that is still there.
function healthFingerprint(r: Report): string {
  const lagging = Boolean(r.raw_pending && r.raw_oldest_hours && r.raw_oldest_hours > ENRICHMENT_LAG_HOURS);
  return [
    r.org,
    `dup=${r.dup_pairs}`,
    `stuck=${r.stuck.map((s) => s.slug).sort().join(",")}`,
    `thin=${r.thin.map((t) => t.name).sort().join(",")}`,
    `low=${r.low_contact.map((l) => l.name).sort().join(",")}`,
    `lag=${lagging ? "yes" : "no"}`,
    // Names, not the count: a different material stalling is a new situation
    // worth re-posting even when the total happens to be unchanged.
    `breadth=${(r.breadth_stalled ?? []).map((m) => m.name).sort().join(",")}`,
    // Bucketed: a backlog drifting by a lead or two is the same situation.
    `undrafted=${r.undrafted ? Math.floor(r.undrafted / 10) : 0}`,
  ].join(" ");
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
    const fingerprints: string[] = [];
    let totalAlerts = 0;
    let totalWarns = 0;
    let checked = 0;

    for (const org of orgs) {
      const { data, error } = await admin.rpc("sourcing_health_report", {
        p_org: org,
        p_min_leads: MIN_LEADS,
        p_min_contact_frac: MIN_CONTACT_FRAC,
        p_stale_hours: STALE_HOURS,
        p_breadth_target: BREADTH_TARGET,
        p_breadth_min_age_hours: BREADTH_MIN_AGE_HOURS,
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
      fingerprints.push(healthFingerprint(report));

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
          breadth_stalled: report.breadth_stalled_count,
          breadth_worst_leads: report.breadth_worst_leads,
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

    // Fleet-wide, so it is checked once rather than per org.
    let dark: { source: string; baseline: number }[] = [];
    try {
      dark = await darkSources(admin);
      for (const d of dark) {
        await ctx.log(
          `Discovery source '${d.source}' has staged 0 leads in ${SOURCE_DARK_HOURS}h (${d.baseline} in the prior ${SOURCE_BASELINE_DAYS}d)`,
          { level: "error", step: "sources", data: { source: d.source, baseline: d.baseline } }
        );
      }
      if (!dark.length) await ctx.log("All discovery sources producing", { step: "sources" });
    } catch (e: any) {
      await ctx.log(`Dark-source check failed (non-fatal): ${e?.message ?? e}`, { level: "warn", step: "sources" });
    }
    if (dark.length) {
      totalAlerts += dark.length;
      sections.push(
        [
          "Discovery sources",
          ...dark.map(
            (d) =>
              `🔴 source '${d.source}' DARK: 0 leads in ${SOURCE_DARK_HOURS}h, was staging ${d.baseline} over the prior ${SOURCE_BASELINE_DAYS}d`
          ),
        ].join("\n")
      );
      fingerprints.push(`dark=${dark.map((d) => d.source).sort().join(",")}`);
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

    const fingerprint = fingerprints.join("|");
    if (!(await shouldPostDigest("sourcing_health", fingerprint))) {
      await ctx.log("Health report identical to the last one posted; staying quiet", { step: "slack" });
      return;
    }
    const res = await postSlackMessage({
      channel: process.env.SOURCING_HEALTH_SLACK_CHANNEL,
      text: `*Sourcing health watchdog* — ${status}\n\`\`\`${sections.join("\n\n")}\`\`\``,
    });
    if (!res.ok) {
      await ctx.log(`Slack digest not sent: ${res.error}`, { level: "warn", step: "slack" });
    } else {
      await recordDigestPosted("sourcing_health", fingerprint);
      await ctx.log("Posted sourcing health digest to Slack", { step: "slack" });
    }
  },
});
