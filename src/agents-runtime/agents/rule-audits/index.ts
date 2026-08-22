import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAllPaged } from "@/lib/supabase-paging";
import { postAgentAlert } from "@/lib/slack-alert";
import { resolveMaterialGradeSpecs } from "@/lib/tenkara-names";
import { stalledFollowupGapMs } from "@/lib/agent-timing";
import { loadOrgStatuses, outreachAllowed } from "@/lib/org-status";
import { loadRecentThreadIds, loadStalledThreadState } from "../reply-manager/stalled-followup";
import { recordAuditFindings, type AuditFinding } from "@/lib/audit-findings";

// Agent 26 - Rule Audits.
//
// Five rules can only be checked against the data. A build check reads the
// code, and all five of these fail with the code intact: a writer that never
// runs, a marker read under a shape nobody writes, a reason column computed and
// discarded, a cadence suppressed by a row from three months ago. Each one was
// found by someone thinking to ask, which is not a control.
//
// Read-only. It reports and never repairs, for the same reason Agent 23 does:
// every one of these needs a person to decide what the right value was.

const LOOKBACK_DAYS = 14;
const STALE_STAGED_DAYS = 14;
const SAMPLE = 5;

type Finding = AuditFinding;

// Every rule this run evaluates, including the ones that come back clean. A
// finding is only closed if the rule that raised it was looked at again, so
// this list is what bounds the close (UI-06).
const AUDITED_RULES = ["PERS-07", "PRICING-04", "DISC-08", "OUT-09", "DATA-08"];

// A finding attributed to no client. DISC-08 is the fleet's own discovery
// state, so there is no client tab it belongs on.
const FLEET = null;

/**
 * Split rows by the client they belong to, so each finding lands on that
 * client's own tab rather than in one fleet-wide pile nobody owns (UI-06).
 * Rows with no org are grouped as fleet-wide rather than dropped.
 */
function byOrg<T>(rows: T[], orgOf: (row: T) => string | null): [string | null, T[]][] {
  const groups = new Map<string | null, T[]>();
  for (const row of rows) {
    const id = orgOf(row);
    const list = groups.get(id);
    if (list) list.push(row);
    else groups.set(id, [row]);
  }
  return [...groups.entries()];
}

const day = 86_400_000;

registerAgent({
  slug: "agent-26-rule-audits",
  displayName: "Agent 26 - Rule Audits",
  description:
    "Daily read-only audit of the five standing rules no build check can see: withheld prices with no reason (PERS-07), delivery cost capture (PRICING-04), discovery cursors and markers (DISC-08), stalled conversations past their chase cadence (OUT-09), and dealbreaker-grade arming against Tenkara (DATA-08). Reports, never repairs.",
  async run(ctx) {
    const admin = createAdminClient();
    const findings: Finding[] = [];
    const now = Date.now();

    // 1. PERS-07 - a withheld price has to say why it was withheld.
    //
    // The reason is prose in extraction_notes, because there is no column for
    // it. That is exactly how it goes missing: five call sites write a prefix
    // and a sixth writes nothing, and the price-index tab then renders an empty
    // cell that reads as "nobody has got to this yet" (UI-10).
    {
      const withheld = await selectAllPaged<any>((from, to) =>
        admin
          .from("staged_quotes")
          .select("id, org_id, extraction_notes, created_at")
          .is("price", null)
          .neq("status", "dismissed")
          .order("id")
          .range(from, to)
      );
      const silent = withheld.filter((q) => !q.extraction_notes || !q.extraction_notes.trim());
      await ctx.log(`${withheld.length} withheld price(s), ${silent.length} with no reason recorded`, {
        step: "pers-07",
      });
      for (const [orgId, rows] of byOrg(silent, (q) => q.org_id ?? null)) {
        const oldest = rows.reduce((a, b) => (a.created_at < b.created_at ? a : b));
        findings.push({
          rule: "PERS-07",
          orgId,
          count: rows.length,
          detail: `withheld price(s) with no reason recorded, of ${withheld.length} withheld fleet-wide. Oldest ${oldest.created_at?.slice(0, 10)}`,
          sample: rows.slice(0, SAMPLE).map((q) => q.id),
        });
      }
    }

    // 2. PRICING-04 - delivery cost capture.
    //
    // Two counters, not one. `mp ? 'shipping_cost'` says the writer ran;
    // a number in it says the writer produced something. The gap between them
    // is the whole check, and today it is the whole population.
    {
      const pulls = await selectAllPaged<any>((from, to) =>
        admin
          .from("leads_in_flight")
          .select("id, org_id, payload->marketplace_pull")
          .not("payload->marketplace_pull", "is", null)
          .order("id")
          .range(from, to)
      );
      let pulled = 0;
      let withKeys = 0;
      let attempted = 0;
      let numeric = 0;
      let reasoned = 0;
      const stuck: { id: string; org_id: string | null }[] = [];
      for (const row of pulls) {
        const mp = row.marketplace_pull as Record<string, unknown> | null;
        if (!mp) continue;
        if (mp.status === "pulled") pulled++;
        if ("shipping_cost" in mp) withKeys++;
        if (mp.shipping_cost_attempted_at != null) attempted++;
        if (typeof mp.shipping_cost === "number") numeric++;
        if (mp.shipping_cost_failed_reason != null) reasoned++;
        else if ("shipping_cost" in mp && mp.shipping_cost == null) stuck.push({ id: row.id, org_id: row.org_id ?? null });
      }
      await ctx.log(
        `delivery cost: ${pulled} pulled, ${withKeys} carry the keys, ${attempted} attempted, ${numeric} captured, ${reasoned} explained`,
        { step: "pricing-04" }
      );
      const broken =
        pulled > 0 && attempted === 0
          ? `row(s) carry the delivery-cost keys and not one attempt was made (${pulled} listings pulled fleet-wide). ` +
            `An attempt needs a ship-to address; if none resolves, nothing is tried and nothing says so`
          : withKeys > 0 && numeric === 0
            ? `attempt(s) at a delivery cost produced no number, and ${withKeys - reasoned} of them recorded no reason either`
            : null;
      if (broken) {
        for (const [orgId, rows] of byOrg(stuck, (r) => r.org_id)) {
          findings.push({
            rule: "PRICING-04",
            orgId,
            count: rows.length,
            detail: broken,
            sample: rows.slice(0, SAMPLE).map((r) => r.id),
          });
        }
      }
    }

    // 3. DISC-08 - a marker written under one shape and read under another.
    //
    // The credit gate reads `done` and defaults a missing one to true, so a
    // marker saved without that key gates its material off the source forever.
    // The cursor half is the opposite fault: keys nobody writes any more, still
    // loaded on every run.
    {
      const { data: leadCreator } = await admin
        .from("agents")
        .select("id")
        .eq("slug", "agent-03-lead-creator")
        .maybeSingle();
      if (!leadCreator) {
        await ctx.log("lead creator not found, skipping the discovery marker checks", { level: "warn", step: "disc-08" });
      } else {
        const state = await selectAllPaged<any>((from, to) =>
          admin
            .from("agent_state")
            .select("key, value, updated_at")
            .eq("agent_id", leadCreator.id)
            .order("key")
            .range(from, to)
        );
        const gates = state.filter((s) => s.key.startsWith("sourceready_searched:"));
        const shapeless = gates.filter((s) => !s.value || typeof s.value !== "object" || !("done" in s.value));
        const orphanCursors = state.filter((s) => s.key.startsWith("discovery_page:sourceready:"));
        await ctx.log(
          `${gates.length} credit-gate marker(s), ${shapeless.length} missing the key the reader looks for; ${orphanCursors.length} cursor(s) nobody writes`,
          { step: "disc-08" }
        );
        if (shapeless.length) {
          findings.push({
            rule: "DISC-08",
            orgId: FLEET,
            count: shapeless.length,
            detail:
              `credit-gate marker(s) of ${gates.length} saved without the \`done\` key. The reader treats a missing ` +
              `\`done\` as finished, so each of these materials is gated off SourceReady permanently`,
            sample: shapeless.slice(0, SAMPLE).map((s) => s.key.replace("sourceready_searched:", "")),
          });
        }
        if (orphanCursors.length) {
          findings.push({
            rule: "DISC-08",
            orgId: FLEET,
            count: orphanCursors.length,
            detail: "SourceReady page cursor(s) written by nobody and read by nobody, still loaded on every discovery run",
            sample: orphanCursors.slice(0, SAMPLE).map((s) => s.key),
          });
        }
      }
    }

    // 4. OUT-09 - a conversation that went quiet gets chased.
    //
    // Measured through the sweep's own loader, not a copy of it. A re-derived
    // audit drifts from the producer and then reports on a pipeline that does
    // not exist; importing it means the two can only ever disagree about the
    // clock. The second half is the one worth watching: a thread is exempt
    // while an operator has something staged on it, and that exemption is
    // evaluated over the whole thread, so one draft nobody ever actioned pauses
    // the chase sequence for good.
    {
      const threadIds = await loadRecentThreadIds(admin);
      const state = await loadStalledThreadState(admin, threadIds);
      const orgStatuses = await loadOrgStatuses(admin);

      const overdue: { id: string; org_id: string | null }[] = [];
      const suppressed: { id: string; org_id: string | null }[] = [];
      for (const [threadId, t] of state) {
        if (!t.lastInboundAt) continue;
        if (t.terminal || t.conversationComplete) continue;
        if (!t.anchor || !t.lastOutboundAt) continue;
        if (t.lastInboundAt > t.lastOutboundAt) continue;
        if (!outreachAllowed(orgStatuses.byOaId.get(t.anchor.org_id) ?? "off")) continue;
        if (now < t.lastOutboundAt + stalledFollowupGapMs(t.anchor.org_id, t.priorNudges)) continue;
        const at = { id: threadId, org_id: t.anchor.org_id ?? null };
        if (t.awaitingOperator) {
          const age = t.awaitingSince === null ? 0 : now - t.awaitingSince;
          if (age > STALE_STAGED_DAYS * day) suppressed.push(at);
          continue;
        }
        overdue.push(at);
      }
      await ctx.log(`${overdue.length} thread(s) past their chase cadence, ${suppressed.length} held by a stale staged draft`, {
        step: "out-09",
      });
      for (const [orgId, rows] of byOrg(overdue, (r) => r.org_id)) {
        findings.push({
          rule: "OUT-09",
          orgId,
          count: rows.length,
          detail: "conversation(s) on a sending client past the follow-up gap with nothing sent",
          sample: rows.slice(0, SAMPLE).map((r) => r.id),
        });
      }
      for (const [orgId, rows] of byOrg(suppressed, (r) => r.org_id)) {
        findings.push({
          rule: "OUT-09",
          orgId,
          count: rows.length,
          detail: `conversation(s) exempt from chasing because a draft has sat staged for more than ${STALE_STAGED_DAYS} days`,
          sample: rows.slice(0, SAMPLE).map((r) => r.id),
        });
      }
    }

    // 5. DATA-08 - the dealbreaker grade a draft asks for.
    //
    // Tenkara rewrites materials nightly and the dealbreaker flag moves with
    // that rewrite, so an audit keyed on updated_at sees nothing. This compares
    // what we armed against what Tenkara says today, per material.
    {
      const since = new Date(now - LOOKBACK_DAYS * day).toISOString();
      const refs = await selectAllPaged<any>((from, to) =>
        admin
          .from("draft_references")
          .select("id, org_id, material_id, metadata")
          .not("material_id", "is", null)
          .gte("created_at", since)
          .order("id")
          .range(from, to)
      );
      const armed = new Map<string, number>();
      const unarmed = new Map<string, number>();
      const orgOfMaterial = new Map<string, string | null>();
      let blocks = 0;
      for (const r of refs) {
        const md = (r.metadata ?? {}) as any;
        const required = typeof md.required_grade === "string" && md.required_grade.trim() ? md.required_grade : null;
        if (!orgOfMaterial.has(r.material_id)) orgOfMaterial.set(r.material_id, r.org_id ?? null);
        const bucket = required ? armed : unarmed;
        bucket.set(r.material_id, (bucket.get(r.material_id) ?? 0) + 1);
        for (const f of md.qa_findings ?? []) if (f?.code === "grade_ask_widened") blocks++;
      }
      const ids = [...new Set([...armed.keys(), ...unarmed.keys()])];
      let specs: Map<string, { required: string | null }> | null = null;
      try {
        specs = await resolveMaterialGradeSpecs(ids);
      } catch (e) {
        // The read-only pooler is flaky. Saying nothing is better than
        // reporting every material as having no dealbreaker.
        await ctx.log(`Tenkara unreachable, skipping the arming comparison: ${(e as Error).message}`, {
          level: "warn",
          step: "data-08",
        });
      }
      if (specs) {
        const disagree: { id: string; org_id: string | null }[] = [];
        for (const id of ids) {
          const required = specs.get(id)?.required ?? null;
          const a = armed.get(id) ?? 0;
          const u = unarmed.get(id) ?? 0;
          const org = orgOfMaterial.get(id) ?? null;
          if (required && u > 0) disagree.push({ id: `${id} ${u} unarmed of ${a + u} (Tenkara requires ${required})`, org_id: org });
          if (!required && a > 0) disagree.push({ id: `${id} ${a} armed of ${a + u} (Tenkara flags no dealbreaker)`, org_id: org });
        }
        await ctx.log(
          `${ids.length} material(s) drafted in ${LOOKBACK_DAYS}d, ${disagree.length} where arming disagrees with Tenkara, ${blocks} grade block(s)`,
          { step: "data-08" }
        );
        for (const [orgId, rows] of byOrg(disagree, (r) => r.org_id)) {
          findings.push({
            rule: "DATA-08",
            orgId,
            count: rows.length,
            detail: `material(s) where what we asked for and what the client flags as a dealbreaker do not agree`,
            sample: rows.slice(0, SAMPLE).map((r) => r.id),
          });
        }
      }
    }

    ctx.setItemsProcessed(findings.reduce((n, f) => n + f.count, 0));

    // UI-06. Persist before reporting. A finding that only ever reached Slack
    // could not be scoped to the client it was about, could not say how long it
    // had been true, and gave the flagged-work registry nothing to render - so
    // the one set UI-06 names by name had no surface at all. Writing here is
    // also what closes the findings that cleared since yesterday.
    const written = await recordAuditFindings(admin, findings, AUDITED_RULES);
    await ctx.log(
      `findings persisted: ${written.opened} new, ${written.updated} restated, ${written.resolved} cleared since the last run`,
      { step: "persist" }
    );

    if (!findings.length) {
      ctx.setStatus("success");
      ctx.setSummary("Clean: withheld prices, delivery costs, discovery markers, chase cadence and grade arming all consistent.");
      return;
    }

    for (const f of findings) {
      await ctx.log(`${f.rule}: ${f.count} ${f.detail}`, {
        level: "warn",
        step: "finding",
        data: { rule: f.rule, count: f.count, sample: f.sample },
      });
    }

    const lines = findings.map((f) => `• *${f.rule}* ${f.count} ${f.detail}\n   ${f.sample.join("\n   ")}`);
    await postAgentAlert(`*Rule audit*\n${lines.join("\n")}`, {
      severity: "p1",
      title: "Rule audits",
      key: `rule_audits:${findings.map((f) => `${f.rule}=${f.count}`).join(",")}`,
      ttlMinutes: 60 * 20,
    });

    ctx.setStatus("partial");
    ctx.setSummary(findings.map((f) => `${f.rule} ${f.count}`).join(", "));
  },
});
