import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { createMissiveDraft, missiveDraftLink } from "@/lib/missive";
import { classifyClient, MISSIVE_ORGANIZATION_ID, MISSIVE_TEAM_ID } from "../quote-revalidation/config";
import { composeOutreachDraft } from "./drafter";

// v1 trim (vs. full spec):
//   - pre-outreach only. Reply tracking + follow-up cadence land with Agent 08.
//   - cron-style sweep of stage='enriched' & status='active' leads, ordered by
//     completeness_score DESC so the best-known suppliers go first.
//   - cap aggressively (env-overridable). The first run is meant to be small
//     and reviewable — operators eyeball every draft in Missive before sending.
//   - deterministic template only (no LLM). Keeps voice consistent across runs
//     and avoids burning OpenAI tokens when the email content is so structured.
//
// Safety: the Missive client refuses `send: true` and `from_field` at both
// compile- and run-time. No email leaves Missive without a human pressing Send.
const DEFAULT_MAX_DRAFTS_PER_RUN = 5;

function envMaxDrafts(): number {
  const v = process.env.OUTREACH_MAX_DRAFTS_PER_RUN;
  if (!v) return DEFAULT_MAX_DRAFTS_PER_RUN;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DRAFTS_PER_RUN;
}

async function getAgentIdBySlug(admin: ReturnType<typeof createAdminClient>, slug: string): Promise<string | null> {
  const { data } = await admin.from("agents").select("id").eq("slug", slug).maybeSingle();
  return data?.id ?? null;
}

registerAgent({
  slug: "agent-04-outreach",
  displayName: "Agent 04 - Outreach",
  description:
    "Composes outreach emails for enriched leads, stages them as Missive drafts (never sends), and promotes leads to stage=ready_for_outreach.",
  async run(ctx) {
    const admin = createAdminClient();
    const maxDrafts = envMaxDrafts();

    if (!process.env.MISSIVE_API_TOKEN) {
      await ctx.log("MISSIVE_API_TOKEN not configured — cannot stage drafts", { level: "error", step: "config" });
      ctx.setStatus("failure");
      ctx.setSummary("MISSIVE_API_TOKEN missing.");
      return;
    }

    const tackleAgentId = await getAgentIdBySlug(admin, ctx.agentSlug);
    if (!tackleAgentId) {
      await ctx.log("Agent row not found by slug", { level: "error", step: "config" });
      ctx.setStatus("failure");
      ctx.setSummary("Agent row missing.");
      return;
    }

    // 1. Pull enriched leads, best completeness first.
    const { data: leads, error: pullErr } = await admin
      .from("leads_in_flight")
      .select("id, org_id, supplier_id, supplier_name, material_id, material_name, payload, confidence_score")
      .eq("stage", "enriched")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(maxDrafts * 4); // over-fetch to allow filtering before capping

    if (pullErr) {
      await ctx.log(`Pull failed: ${pullErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${pullErr.message}`);
      return;
    }
    if (!leads || leads.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No enriched leads ready for outreach.");
      return;
    }
    await ctx.log(`Pulled ${leads.length} enriched leads (pre-filter)`, { step: "pull" });

    // 2. Resolve org info + classify in one pass. We only contact suppliers on
    //    behalf of orgs that map cleanly to a known active/ghost label.
    const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
    let orgsById = new Map<string, { id: string; name: string; tenkara_org_id: string | null; primary_user_id: string | null; backup_user_id: string | null }>();
    if (orgIds.length) {
      const { data: orgRows } = await admin
        .from("orgs")
        .select("id, name, tenkara_org_id, org_default_operators(primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(status))")
        .in("id", orgIds);
      for (const r of (orgRows ?? []) as any[]) {
        const ops = r.org_default_operators?.[0] ?? r.org_default_operators ?? null;
        const ooo = ops?.primary_user?.status === "out_of_office";
        orgsById.set(r.id, {
          id: r.id,
          name: r.name,
          tenkara_org_id: r.tenkara_org_id ?? null,
          primary_user_id: ops ? (ooo ? (ops.backup_user_id ?? ops.primary_user_id) : ops.primary_user_id) : null,
          backup_user_id: ops?.backup_user_id ?? null,
        });
      }
    }

    // 3. Filter to leads we can actually draft for.
    type Candidate = {
      lead: (typeof leads)[number];
      email: string;
      contactName: string | null;
      mode: "active" | "ghost";
      ghostBrand?: string;
      clientOrgName: string;
      assignedOperator: string | null;
    };

    const candidates: Candidate[] = [];
    let droppedNoEmail = 0;
    let droppedNoOrg = 0;
    let droppedSkipClient = 0;

    for (const lead of leads) {
      const payload = (lead.payload ?? {}) as any;
      const email = payload.supplier_contact_email as string | undefined;
      const formatValid = payload.enrichment?.email_check?.format_valid === true;
      if (!email || !formatValid) {
        droppedNoEmail++;
        continue;
      }
      if (!lead.org_id) {
        droppedNoOrg++;
        continue;
      }
      const org = orgsById.get(lead.org_id);
      if (!org) {
        droppedNoOrg++;
        continue;
      }
      const cls = classifyClient(org.name);
      if (cls.mode === "skip") {
        droppedSkipClient++;
        continue;
      }
      candidates.push({
        lead,
        email,
        contactName: payload.supplier_contact_name ?? null,
        mode: cls.mode,
        ghostBrand: cls.ghostBrand,
        clientOrgName: org.name,
        assignedOperator: org.primary_user_id,
      });
    }

    await ctx.log(
      `Filtered: ${candidates.length} draftable · dropped ${droppedNoEmail} (no/invalid email), ${droppedNoOrg} (no org map), ${droppedSkipClient} (unclassified client)`,
      { step: "filter" }
    );

    if (candidates.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(`No draftable leads after filters (no_email=${droppedNoEmail}, no_org=${droppedNoOrg}, skip_client=${droppedSkipClient}).`);
      return;
    }

    // 4. Dedup against existing staged drafts (same supplier × material × agent).
    const cleanCandidates: Candidate[] = [];
    let dedupSkipped = 0;
    for (const c of candidates) {
      if (cleanCandidates.length >= maxDrafts) break;
      const { data: existing } = await admin
        .from("draft_references")
        .select("id")
        .eq("agent_id", tackleAgentId)
        .eq("supplier_id", c.lead.supplier_id)
        .eq("material_id", c.lead.material_id)
        .eq("status", "staged")
        .maybeSingle();
      if (existing) {
        dedupSkipped++;
        continue;
      }
      cleanCandidates.push(c);
    }

    await ctx.log(`After dedup: ${cleanCandidates.length} → Missive (skipped ${dedupSkipped} already-staged)`, { step: "dedup" });

    if (cleanCandidates.length === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(`All ${candidates.length} candidates already have staged drafts.`);
      return;
    }

    // 5. Compose + stage in Missive serially. Missive API has loose rate limits
    //    but staging outreach is meant to be deliberate — no concurrency win.
    let staged = 0;
    let missiveErrors = 0;
    let promoted = 0;

    for (const c of cleanCandidates) {
      const payload = (c.lead.payload ?? {}) as any;
      const draft = composeOutreachDraft({
        mode: c.mode,
        ghostBrand: c.ghostBrand,
        clientOrgName: c.clientOrgName,
        supplierContactName: c.contactName,
        supplierCompanyName: c.lead.supplier_name ?? null,
        materialName: c.lead.material_name ?? "the material",
        inciName: payload.inci_name ?? null,
        signal: payload.signal ?? null,
      });

      let missiveDraft;
      try {
        missiveDraft = await createMissiveDraft({
          subject: draft.subject,
          body: draft.body,
          to_fields: [{ name: c.contactName ?? "", address: c.email }],
          organization: MISSIVE_ORGANIZATION_ID,
          team: MISSIVE_TEAM_ID,
          add_to_team_inbox: true,
        });
      } catch (e: any) {
        missiveErrors++;
        await ctx.log(`Missive error for ${c.lead.supplier_name} × ${c.lead.material_name}: ${e.message}`, {
          level: "warn",
          step: "missive",
          data: { lead_id: c.lead.id },
        });
        continue;
      }
      staged++;
      await ctx.log(`Staged draft: ${c.lead.supplier_name} → ${c.lead.material_name} (${c.mode})`, {
        step: "missive",
        data: {
          lead_id: c.lead.id,
          missive_draft_id: missiveDraft.id,
          missive_conversation_id: missiveDraft.conversation_id,
        },
      });

      // 5a. Register draft pointer.
      const { error: drErr } = await admin.from("draft_references").insert({
        email_client: "missive",
        thread_id: missiveDraft.conversation_id ?? "",
        draft_id: missiveDraft.id,
        agent_id: tackleAgentId,
        agent_run_id: ctx.runId,
        org_id: c.lead.org_id,
        supplier_id: c.lead.supplier_id,
        material_id: c.lead.material_id,
        subject: draft.subject,
        body_preview: draft.body.slice(0, 1500),
        assigned_operator: c.assignedOperator,
        metadata: {
          outreach_mode: c.mode,
          ghost_brand: c.ghostBrand ?? null,
          suggested_signoff: c.mode === "ghost" ? `${c.ghostBrand} Sourcing` : `${c.clientOrgName} Purchasing Team`,
          missive_draft_link: missiveDraft.conversation_id
            ? missiveDraftLink(missiveDraft.conversation_id, missiveDraft.id)
            : null,
          lead_id: c.lead.id,
        },
      });
      if (drErr) {
        await ctx.log(`draft_references insert failed for lead ${c.lead.id}: ${drErr.message}`, {
          level: "error",
          step: "register",
        });
        // Don't promote stage if we couldn't register the pointer — keeps the
        // pipeline auditable.
        continue;
      }

      // 5b. Promote the lead.
      const newPayload = {
        ...payload,
        outreach: {
          missive_draft_id: missiveDraft.id,
          missive_conversation_id: missiveDraft.conversation_id ?? null,
          mode: c.mode,
          ghost_brand: c.ghostBrand ?? null,
          staged_at: new Date().toISOString(),
          staged_by_run_id: ctx.runId,
        },
      };
      const { error: upErr } = await admin
        .from("leads_in_flight")
        .update({ stage: "ready_for_outreach", payload: newPayload })
        .eq("id", c.lead.id);
      if (upErr) {
        await ctx.log(`Stage promotion failed for lead ${c.lead.id}: ${upErr.message}`, {
          level: "error",
          step: "promote",
        });
        continue;
      }
      promoted++;
    }

    ctx.setItemsProcessed(staged);
    ctx.setStatus(missiveErrors > 0 && staged === 0 ? "failure" : missiveErrors > 0 ? "partial" : "success");
    ctx.setSummary(
      `Staged ${staged} Missive draft${staged === 1 ? "" : "s"} · promoted ${promoted} to ready_for_outreach` +
        (missiveErrors ? ` · ${missiveErrors} Missive errors` : "") +
        (dedupSkipped ? ` · skipped ${dedupSkipped} already-staged` : "") +
        (droppedNoEmail || droppedNoOrg || droppedSkipClient
          ? ` · dropped ${droppedNoEmail + droppedNoOrg + droppedSkipClient} pre-filter`
          : "")
    );
  },
});
