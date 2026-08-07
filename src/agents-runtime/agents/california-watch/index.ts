import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAllPaged } from "@/lib/supabase-paging";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { postSlackMessage } from "@/lib/slack";

// Agent 17 — California Chemicals sourcing-breadth watch.
//
// Ported from the container-side `california-chemicals-watchdog` skill. It
// tracks a real client's onboarding: confirm discovery started, then report
// per-material supplier breadth against the 100-supplier target, and flag the
// three end-states (cleared / stalled / saturated).
//
// Every message is deduped, so the channel only hears about changes. The skill
// kept that dedup state in a JSON file on the container's disk, which is why it
// died whenever the laptop slept; here it lives in one agent_state row.

const TENKARA_ORG_ID = "c372ad33-8ca2-4533-8eec-e01f408f841c";
const OA_ORG_ID = "bfb42d8c-7435-44ef-a914-91869b1e726b";
const SLACK_CHANNEL = "C0BATUWBHC7"; // #control-room-feedback
const STATE_KEY = "california_watch";
const LEAD_CREATOR_SLUG = "agent-03-lead-creator";

const TARGET_LEADS = 100;
const THIN_THRESHOLD = 25;
// Flag a material only once it has had a full re-scout opportunity that added
// nothing. This MUST stay above the discovery agent's
// LEAD_CREATOR_RESCOUT_BACKOFF_HOURS (prod is 6h): a material is *expected* to
// sit static for the whole backoff window, so a shorter threshold false-alarms
// every cycle. Re-align it if that env changes.
const STALL_HOURS = 16;
// A material is saturated once discovery has logged this many consecutive
// re-scout cycles each adding fewer than MIN_NEW_PER_CYCLE suppliers, at which
// point the agent drops it to a weekly re-check. Read live from the agent's own
// resource_attempt:<material_id> markers; keep aligned with its DISCOVERY_* envs.
const DRY_STREAK_LIMIT = Number(process.env.DISCOVERY_DRY_STREAK_LIMIT ?? 3);
const MIN_NEW_PER_CYCLE = Number(process.env.DISCOVERY_MIN_NEW_PER_CYCLE ?? 5);

interface MaterialState {
  last_total: number;
  last_change_at: string;
  cleared: boolean;
  stall_flagged: boolean;
  saturated_flagged: boolean;
}

interface WatchState {
  announced_kickoff: boolean;
  last_total_leads: number;
  last_report_at: string | null;
  materials_first_seen_at: string | null;
  over_24h_flagged: boolean;
  discovery_complete_flagged: boolean;
  materials: Record<string, MaterialState>;
}

const EMPTY_STATE: WatchState = {
  announced_kickoff: false,
  last_total_leads: 0,
  last_report_at: null,
  materials_first_seen_at: null,
  over_24h_flagged: false,
  discovery_complete_flagged: false,
  materials: {},
};

interface Breadth {
  total: number;
  raw: number;
  enriched: number;
  other: number;
}

registerAgent({
  slug: "agent-17-california-watch",
  displayName: "Agent 17 - California Chemicals Watch",
  description:
    "Tracks California Chemicals supplier breadth against the 100-supplier target: announces discovery kickoff, reports per-material progress when the lead count moves, and flags cleared, stalled, and saturated materials. Read-only; deduped so it only speaks on change.",
  async run(ctx) {
    const admin = createAdminClient();

    const { data: stateRow } = await admin
      .from("agent_state")
      .select("value")
      .eq("agent_id", ctx.agentId)
      .eq("key", STATE_KEY)
      .maybeSingle();
    const state: WatchState = { ...EMPTY_STATE, ...((stateRow?.value as Partial<WatchState>) ?? {}) };
    state.materials = { ...(state.materials ?? {}) };

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const outbox: string[] = [];

    // 1. Materials on the Tenkara side. Zero means onboarding hasn't happened
    // yet, which is not news — stay silent.
    const materialRows = await tenkaraQuery<{ name: string }>(
      `select m.name from materials m
         join users u on u.id = m.user_id
        where u.organization_id = $1`,
      [TENKARA_ORG_ID]
    );
    const materialNames = materialRows.map((r) => r.name).filter(Boolean);
    const nMaterials = materialNames.length;
    if (nMaterials === 0) {
      ctx.setStatus("success");
      ctx.setSummary("0 materials in California Chemicals — nothing to report.");
      await ctx.log("No materials yet; staying silent", { step: "materials" });
      return;
    }
    if (!state.materials_first_seen_at) state.materials_first_seen_at = nowIso;

    // 2. Lead breadth. Seed every known material at 0 so a material with no
    // leads still shows up — those are the thinnest and the most worth flagging.
    const leads = await selectAllPaged<{ material_name: string | null; material_id: string | null; stage: string | null }>(
      (from, to) =>
        admin
          .from("leads_in_flight")
          .select("material_name,material_id,stage")
          .eq("org_id", OA_ORG_ID)
          .eq("status", "active")
          .order("id")
          .range(from, to)
    );

    const perMaterial = new Map<string, Breadth>();
    for (const name of materialNames) perMaterial.set(name, { total: 0, raw: 0, enriched: 0, other: 0 });
    const nameToId = new Map<string, string>();
    for (const row of leads) {
      const name = row.material_name || "(unnamed)";
      if (row.material_id && !nameToId.has(name)) nameToId.set(name, row.material_id);
      const d = perMaterial.get(name) ?? { total: 0, raw: 0, enriched: 0, other: 0 };
      d.total += 1;
      if (row.stage === "raw") d.raw += 1;
      else if (row.stage === "enriched") d.enriched += 1;
      else d.other += 1;
      perMaterial.set(name, d);
    }
    const totalLeads = [...perMaterial.values()].reduce((n, d) => n + d.total, 0);

    // 3. Saturation, read from the discovery agent's own per-material markers.
    const saturation = new Map<string, number>();
    const { data: leadCreator } = await admin
      .from("agents")
      .select("id")
      .eq("slug", LEAD_CREATOR_SLUG)
      .maybeSingle();
    if (leadCreator?.id && nameToId.size) {
      const keys = [...nameToId.values()].map((id) => `resource_attempt:${id}`);
      const { data: markers } = await admin
        .from("agent_state")
        .select("key,value")
        .eq("agent_id", leadCreator.id)
        .in("key", keys);
      const byKey = new Map((markers ?? []).map((m: any) => [m.key, m.value]));
      for (const [name, id] of nameToId) {
        const dry = (byKey.get(`resource_attempt:${id}`) as any)?.dry;
        if (typeof dry === "number") saturation.set(name, dry);
      }
    }

    // 4. Kickoff, announced exactly once.
    if (!state.announced_kickoff) {
      outbox.push(
        `Sourcing kicked off for California Chemicals — ${nMaterials} material(s) detected, discovery running.`
      );
      state.announced_kickoff = true;
    }

    // 5. Breadth report, only when the total moved.
    if (totalLeads !== state.last_total_leads) {
      const lines = [`*California Chemicals — supplier breadth* (${nMaterials} materials)`];
      for (const [name, d] of [...perMaterial.entries()].sort((a, b) => b[1].total - a[1].total)) {
        const pct = Math.min(100, Math.round((100 * d.total) / TARGET_LEADS));
        const flag = d.total < THIN_THRESHOLD ? "  ⚠️ thin — needs more scouting" : "";
        lines.push(
          `• ${name}: ${d.total}/${TARGET_LEADS} suppliers (${pct}%), raw=${d.raw} enriched=${d.enriched}${flag}`
        );
      }
      lines.push(await outreachLine(admin));
      outbox.push(lines.join("\n"));
      state.last_total_leads = totalLeads;
    }

    // 6. Per-material milestones.
    const stalls: string[] = [];
    let saturatedCount = 0;
    for (const [name, d] of perMaterial) {
      const ms: MaterialState = state.materials[name] ?? {
        // Seed last_change_at to now on first sight, so a fresh deploy can never
        // false-fire a stall against a material it has simply never seen before.
        last_total: d.total,
        last_change_at: nowIso,
        cleared: false,
        stall_flagged: false,
        saturated_flagged: false,
      };

      if (d.total !== ms.last_total) {
        ms.last_change_at = nowIso;
        ms.last_total = d.total;
        ms.stall_flagged = false; // movement clears any prior stall flag
      }

      if (d.total >= TARGET_LEADS && !ms.cleared) {
        ms.cleared = true;
        outbox.push(
          `✅ *${name}* cleared the ${TARGET_LEADS}-supplier floor — now ${d.total} suppliers (raw=${d.raw} enriched=${d.enriched}).`
        );
      } else if (d.total < TARGET_LEADS && !ms.cleared) {
        const idleH = (nowMs - new Date(ms.last_change_at).getTime()) / 3_600_000;
        if (idleH >= STALL_HOURS && !ms.stall_flagged) {
          ms.stall_flagged = true;
          stalls.push(`• ${name}: stuck at ${d.total}/${TARGET_LEADS} for ~${idleH.toFixed(1)}h`);
        }
      }

      // Saturation is the *expected* end state (discovery found everyone), not
      // a problem — worded so ops can close the material rather than chase it.
      const dry = saturation.get(name) ?? 0;
      if (dry >= DRY_STREAK_LIMIT) {
        saturatedCount += 1;
        if (!ms.saturated_flagged) {
          ms.saturated_flagged = true;
          outbox.push(
            `🏁 *${name}* looks saturated — discovery logged ${dry} consecutive re-scout cycles adding <${MIN_NEW_PER_CYCLE} new suppliers. Now ${d.total} suppliers; it has dropped to a weekly re-check, so do not expect much more. Safe to consider this material closed unless the market grows.`
          );
        }
      } else if (ms.saturated_flagged) {
        ms.saturated_flagged = false; // grew again, so it can re-fire later
      }

      state.materials[name] = ms;
    }

    if (saturatedCount === nMaterials) {
      if (!state.discovery_complete_flagged) {
        state.discovery_complete_flagged = true;
        outbox.push(
          `✅ *California Chemicals — discovery complete.* All ${nMaterials} materials are saturated (no meaningful new suppliers for several re-scout cycles); ${totalLeads} suppliers total. Safe to close out sourcing discovery — marketplace pricing and enrichment keep running.`
        );
      }
    } else {
      state.discovery_complete_flagged = false;
    }

    if (stalls.length) {
      outbox.push(
        `⚠️ *California Chemicals — discovery stall* (no new suppliers in ~${STALL_HOURS}h+ while still under ${TARGET_LEADS}):\n${stalls.join("\n")}\nMay need a discovery nudge or investigation.`
      );
    }

    // 7. One-time breadth-problem flag once the materials have had a day to run.
    if (
      state.materials_first_seen_at &&
      nowMs - new Date(state.materials_first_seen_at).getTime() > 24 * 3_600_000 &&
      !state.over_24h_flagged
    ) {
      const farBelow = [...perMaterial.entries()]
        .filter(([, d]) => d.total < TARGET_LEADS * 0.5)
        .map(([name]) => name);
      if (farBelow.length >= Math.max(1, Math.floor(perMaterial.size / 2))) {
        outbox.push(
          `⚠️ California Chemicals: materials have existed >24h and ${farBelow.length}/${perMaterial.size} are still far below the ${TARGET_LEADS}-supplier target (${farBelow.join(", ")}). Discovery yield may need investigation.`
        );
        state.over_24h_flagged = true;
      }
    }

    // Post first, persist second. If a post fails the run fails and the state is
    // not advanced, so the next run retries it rather than silently swallowing
    // the only notification anyone would have seen.
    for (const msg of outbox) {
      const res = await postSlackMessage({ channel: SLACK_CHANNEL, text: msg });
      if (!res.ok) throw new Error(`Slack post failed: ${res.error}`);
    }

    state.last_report_at = nowIso;
    const { error: saveErr } = await admin
      .from("agent_state")
      .upsert({ agent_id: ctx.agentId, key: STATE_KEY, value: state }, { onConflict: "agent_id,key" });
    if (saveErr) throw new Error(`state save failed: ${saveErr.message}`);

    ctx.setItemsProcessed(outbox.length);
    ctx.setStatus("success");
    ctx.setSummary(
      outbox.length
        ? `${totalLeads} leads across ${nMaterials} materials — posted ${outbox.length} update(s)`
        : `${totalLeads} leads across ${nMaterials} materials — no change, stayed silent`
    );
    await ctx.log(`${totalLeads} leads, ${outbox.length} message(s) posted`, {
      step: "breadth",
      data: { total_leads: totalLeads, materials: nMaterials, saturated: saturatedCount, posted: outbox.length },
    });
  },
});

// Whether outreach is actually live: sourcing is Active AND a Tenkara inbox is
// configured. Flips on its own when California goes live, with no code edit.
// Best-effort — any read failure reports "held", which is the safer message.
async function outreachLine(admin: ReturnType<typeof createAdminClient>): Promise<string> {
  const { data } = await admin
    .from("orgs")
    .select("sourcing_status,tenkara_email_account_id")
    .eq("id", OA_ORG_ID)
    .maybeSingle();
  const live = data?.sourcing_status === "active" && Boolean(data?.tenkara_email_account_id);
  return live
    ? "✅ Outreach LIVE — sending from California's Tenkara inbox."
    : "Outreach HELD until California's Tenkara inbox is set in the Control Room and Sourcing is Active.";
}
