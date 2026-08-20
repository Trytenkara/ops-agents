import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { postAgentAlert } from "@/lib/slack-alert";
import snapshot from "@/lib/rules-ledger.generated.json";

// SHIP-08 - Weekly rules review.
//
// The rulebook is audited only when someone thinks to ask. It was asked on
// 2026-08-18 and again on 2026-08-20, and both times the answer had moved a
// long way: a ledger claiming a rule was enforced while its guard was
// uncommitted, a guard matching zero of the 1,083 lines it was written for,
// four skills breaking a rule the day after it was written. None of that was
// hidden. Nothing was looking.
//
// So this is the thing that looks. It compares the rulebook against the last
// time it ran and reports what moved, which is the only form of this report
// anyone will read twice: a weekly dump of 120 rules would be ignored by the
// third week.
//
// It reads a snapshot generated at build time rather than the rules folder,
// because nothing imports those files so nothing bundles them, and a review
// that fetched them over the network could report an outage as "no changes".
// The build refuses if that snapshot has drifted from the rule files.

type Snapshot = typeof snapshot;
type Rule = Snapshot["rules"][number];

interface Stored {
  rules: Record<string, string>;
  outstanding: string[];
  conflicts: string[];
}

const store = (s: Snapshot): Stored => ({
  rules: Object.fromEntries(s.rules.map((r) => [r.id, r.bucket])),
  outstanding: s.outstanding,
  conflicts: s.conflicts,
});

const isOpen = (heading: string) => /\bOPEN\b/.test(heading);

registerAgent({
  slug: "agent-25-rules-review",
  displayName: "Agent 25 - Weekly Rules Review",
  description:
    "Weekly SHIP-08 review of the standing rules: what rules were added, what moved between enforced and owed, what is on the outstanding list, and any conflict still waiting on a ruling. Compares against the previous review and reports only what changed. Read-only.",
  async run(ctx) {
    const admin = createAdminClient();
    const now = store(snapshot);

    const { data: lastRun } = await admin
      .from("agent_runs")
      .select("run_started_at, metadata")
      .eq("agent_id", ctx.agentId)
      .eq("status", "success")
      .neq("id", ctx.runId)
      .not("metadata->rules", "is", null)
      .order("run_started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const before: Stored | null = (lastRun?.metadata as Stored | undefined) ?? null;

    const owed = snapshot.rules.filter((r: Rule) => r.owes);
    const enforced = snapshot.rules.filter((r: Rule) => r.bucket === "Guard" || r.bucket === "Audit");
    const open = snapshot.conflicts.filter(isOpen);

    ctx.setItemsProcessed(snapshot.rules.length);
    ctx.setMetadata(now);

    const headline =
      `${snapshot.rules.length} rules, ${enforced.length} enforced, ${owed.length} owing a check or a job. ` +
      `${snapshot.outstanding.length} sections on the outstanding list. ` +
      (open.length ? `${open.length} conflict(s) waiting on a ruling.` : "No conflict waiting on a ruling.");

    // The first run has nothing to compare against. Say so rather than
    // reporting "nothing changed", which is the same sentence meaning the
    // opposite thing.
    if (!before) {
      await ctx.log("no previous review to compare against, recording a baseline", { step: "baseline" });
      await postAgentAlert(`*Weekly rules review* - baseline.\n${headline}`, {
        severity: "p2",
        title: "Weekly rules review",
        key: "rules_review:baseline",
        ttlMinutes: 60 * 24 * 6,
      });
      ctx.setStatus("success");
      ctx.setSummary(`Baseline recorded. ${headline}`);
      return;
    }

    const lines: string[] = [];
    const added = snapshot.rules.filter((r: Rule) => !(r.id in before.rules));
    const removed = Object.keys(before.rules).filter((id) => !(id in now.rules));
    const moved = snapshot.rules.filter(
      (r: Rule) => r.id in before.rules && before.rules[r.id] !== r.bucket
    );

    if (added.length) {
      lines.push(`*${added.length} new rule(s)*: ${added.map((r) => `${r.id} (${r.bucket})`).join(", ")}`);
    }
    // A rule leaving the book is rare and always deliberate, so it is worth a
    // line even though it is usually a retirement.
    if (removed.length) lines.push(`*${removed.length} rule(s) gone*: ${removed.join(", ")}`);
    for (const r of moved) {
      lines.push(`${r.id} moved ${before.rules[r.id]} -> ${r.bucket}`);
    }

    const newSections = now.outstanding.filter((s) => !before.outstanding.includes(s));
    const goneSections = before.outstanding.filter((s) => !now.outstanding.includes(s));
    if (newSections.length) lines.push(`*Newly outstanding*: ${newSections.join("; ")}`);
    if (goneSections.length) lines.push(`*Closed or reworded*: ${goneSections.join("; ")}`);

    const newConflicts = now.conflicts.filter((c) => !before.conflicts.includes(c));
    if (newConflicts.length) lines.push(`*Conflicts changed*: ${newConflicts.join("; ")}`);
    if (open.length) lines.push(`*Waiting on a ruling*: ${open.join("; ")}`);

    for (const l of lines) await ctx.log(l, { step: "change" });

    const body = lines.length
      ? `*Weekly rules review*\n${headline}\n${lines.map((l) => `• ${l}`).join("\n")}`
      : `*Weekly rules review*\nNothing moved this week. ${headline}`;

    await postAgentAlert(body, {
      severity: "p2",
      title: "Weekly rules review",
      // Keyed on what changed, so an unchanged week does not re-post the same
      // message and an eventful one is never suppressed as a duplicate.
      key: `rules_review:${added.length},${removed.length},${moved.length},${newSections.length},${open.length}`,
      ttlMinutes: 60 * 24 * 6,
    });

    ctx.setStatus("success");
    ctx.setSummary(lines.length ? `${lines.length} change(s). ${headline}` : `No change. ${headline}`);
  },
});
