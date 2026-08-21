import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAllPaged } from "@/lib/supabase-paging";
import { postAgentAlert } from "@/lib/slack-alert";
import { resolveMaterialGradeSpecs } from "@/lib/tenkara-names";
import { stalledFollowupGapMs } from "@/lib/agent-timing";
import { loadOrgStatuses, outreachAllowed } from "@/lib/org-status";
import { loadRecentThreadIds, loadStalledThreadState } from "../reply-manager/stalled-followup";

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

interface Finding {
  rule: string;
  count: number;
  detail: string;
  sample: string[];
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
      if (silent.length) {
        const oldest = silent.reduce((a, b) => (a.created_at < b.created_at ? a : b));
        findings.push({
          rule: "PERS-07",
          count: silent.length,
          detail: `withheld price(s) with no reason recorded, of ${withheld.length} withheld. Oldest ${oldest.created_at?.slice(0, 10)}`,
          sample: silent.slice(0, SAMPLE).map((q) => q.id),
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
          .select("id, payload->marketplace_pull")
          .not("payload->marketplace_pull", "is", null)
          .order("id")
          .range(from, to)
      );
      let pulled = 0;
      let withKeys = 0;
      let attempted = 0;
      let numeric = 0;
      let reasoned = 0;
      const stuck: string[] = [];
      for (const row of pulls) {
        const mp = row.marketplace_pull as Record<string, unknown> | null;
        if (!mp) continue;
        if (mp.status === "pulled") pulled++;
        if ("shipping_cost" in mp) withKeys++;
        if (mp.shipping_cost_attempted_at != null) attempted++;
        if (typeof mp.shipping_cost === "number") numeric++;
        if (mp.shipping_cost_failed_reason != null) reasoned++;
        else if ("shipping_cost" in mp && mp.shipping_cost == null && stuck.length < SAMPLE) stuck.push(row.id);
      }
      await ctx.log(
        `delivery cost: ${pulled} pulled, ${withKeys} carry the keys, ${attempted} attempted, ${numeric} captured, ${reasoned} explained`,
        { step: "pricing-04" }
      );
      if (pulled > 0 && attempted === 0) {
        findings.push({
          rule: "PRICING-04",
          count: withKeys,
          detail:
            `row(s) carry the delivery-cost keys and not one attempt was made (${pulled} listings pulled). ` +
            `An attempt needs a ship-to address; if none resolves, nothing is tried and nothing says so`,
          sample: stuck,
        });
      } else if (withKeys > 0 && numeric === 0) {
        findings.push({
          rule: "PRICING-04",
          count: attempted,
          detail: `attempt(s) at a delivery cost produced no number, and ${withKeys - reasoned} of them recorded no reason either`,
          sample: stuck,
        });
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

      const overdue: string[] = [];
      const suppressed: string[] = [];
      for (const [threadId, t] of state) {
        if (!t.lastInboundAt) continue;
        if (t.terminal || t.conversationComplete) continue;
        if (!t.anchor || !t.lastOutboundAt) continue;
        if (t.lastInboundAt > t.lastOutboundAt) continue;
        if (!outreachAllowed(orgStatuses.byOaId.get(t.anchor.org_id) ?? "off")) continue;
        if (now < t.lastOutboundAt + stalledFollowupGapMs(t.anchor.org_id, t.priorNudges)) continue;
        if (t.awaitingOperator) {
          const age = t.awaitingSince === null ? 0 : now - t.awaitingSince;
          if (age > STALE_STAGED_DAYS * day) suppressed.push(threadId);
          continue;
        }
        overdue.push(threadId);
      }
      await ctx.log(`${overdue.length} thread(s) past their chase cadence, ${suppressed.length} held by a stale staged draft`, {
        step: "out-09",
      });
      if (overdue.length) {
        findings.push({
          rule: "OUT-09",
          count: overdue.length,
          detail: "conversation(s) on a sending client past the follow-up gap with nothing sent",
          sample: overdue.slice(0, SAMPLE),
        });
      }
      if (suppressed.length) {
        findings.push({
          rule: "OUT-09",
          count: suppressed.length,
          detail: `conversation(s) exempt from chasing because a draft has sat staged for more than ${STALE_STAGED_DAYS} days`,
          sample: suppressed.slice(0, SAMPLE),
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
          .select("id, material_id, metadata")
          .not("material_id", "is", null)
          .gte("created_at", since)
          .order("id")
          .range(from, to)
      );
      const armed = new Map<string, number>();
      const unarmed = new Map<string, number>();
      let blocks = 0;
      for (const r of refs) {
        const md = (r.metadata ?? {}) as any;
        const required = typeof md.required_grade === "string" && md.required_grade.trim() ? md.required_grade : null;
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
        const disagree: string[] = [];
        for (const id of ids) {
          const required = specs.get(id)?.required ?? null;
          const a = armed.get(id) ?? 0;
          const u = unarmed.get(id) ?? 0;
          if (required && u > 0) disagree.push(`${id} ${u} unarmed of ${a + u} (Tenkara requires ${required})`);
          if (!required && a > 0) disagree.push(`${id} ${a} armed of ${a + u} (Tenkara flags no dealbreaker)`);
        }
        await ctx.log(
          `${ids.length} material(s) drafted in ${LOOKBACK_DAYS}d, ${disagree.length} where arming disagrees with Tenkara, ${blocks} grade block(s)`,
          { step: "data-08" }
        );
        if (disagree.length) {
          findings.push({
            rule: "DATA-08",
            count: disagree.length,
            detail: `material(s) where what we asked for and what the client flags as a dealbreaker do not agree`,
            sample: disagree.slice(0, SAMPLE),
          });
        }
      }
    }

    ctx.setItemsProcessed(findings.reduce((n, f) => n + f.count, 0));

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
