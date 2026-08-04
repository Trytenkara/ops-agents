import type { createAdminClient } from "@/lib/supabase/admin";
import { drainContactApiCalls } from "@/lib/contact-provider-usage";
import { enrichLead, isAggregatorEmail, type RawLead } from "./enrich";

// Per-lead enrichment: run enrichLead(), merge the result into the lead payload,
// and either promote to stage=enriched or leave at raw with a blocked_reason.
//
// Every exit path that reaches the lead stamps last_enrichment_attempt_at, which
// is what the sweep orders by. A lead left unstamped keeps its place at the head
// of the queue and is retried every run forever, starving everything behind it.

type Admin = ReturnType<typeof createAdminClient>;

export interface EnrichOutcome {
  status: "promoted" | "blocked" | "error" | "superseded";
  reason?: string;
  completeness?: number;
}

// Persist the paid-contact-provider calls this lead made. This is the only
// durable record that a provider was reached at all: a quota-exhausted provider
// returns the same null as a genuine miss, so without these rows an exhausted
// Hunter just looks like a Hunter that never finds anything, while spend
// quietly reroutes to ZoomInfo. Also the input to Settings > "API usage & cost".
//
// Best-effort: a failed insert is logged and dropped. Usage bookkeeping must
// never fail a lead that enriched fine.
async function flushContactApiCalls(
  admin: Admin,
  runId: string,
  leadId: string,
  log: (msg: string, meta?: any) => Promise<void> | void
): Promise<void> {
  const calls = drainContactApiCalls();
  if (!calls.length) return;

  const rows = calls.map((c) => ({
    run_id: runId,
    level: c.outcome === "hit" || c.outcome === "miss" ? "info" : "warn",
    step: c.provider,
    message: `${c.provider} ${c.outcome}${c.units ? ` (${c.units} billable)` : ""}${c.detail ? ` — ${c.detail}` : ""}`,
    data: { outcome: c.outcome, units: c.units, domain: c.domain, lead_id: leadId },
  }));

  const { error } = await admin.from("agent_run_events").insert(rows);
  if (error) await log(`Contact-provider usage log failed: ${error.message}`, { step: "usage", data: { lead_id: leadId } });

  // A quota wall is the one outcome that changes what the fleet should do next,
  // so surface it in the run log rather than leaving it buried in the events table.
  for (const c of calls) {
    if (c.outcome === "quota" || c.outcome === "auth") {
      await log(`${c.provider} ${c.outcome === "quota" ? "quota exhausted" : "auth rejected"} — lookups are now falling through to the next provider`, {
        step: c.provider,
        data: { lead_id: leadId, detail: c.detail },
      });
    }
  }
}

export async function enrichAndStageLead(
  lead: RawLead,
  deps: { admin: Admin; runId: string; log?: (msg: string, meta?: any) => Promise<void> | void }
): Promise<EnrichOutcome> {
  const { admin, runId } = deps;
  const log = deps.log ?? (async () => {});
  const attemptedAt = new Date().toISOString();

  let result;
  try {
    result = await enrichLead(lead);
  } catch (e: any) {
    await log(`Enrichment threw for lead ${lead.id}: ${e?.message ?? e}`, { step: "enrich", data: { lead_id: lead.id } });
    // A throw mid-waterfall may still have spent provider credits.
    await flushContactApiCalls(admin, runId, lead.id, log);
    // Stamp before bailing: a throw still consumed an attempt, and an unstamped
    // lead sorts first forever.
    const { data, error: stampErr } = await admin
      .from("leads_in_flight")
      .update({ last_enrichment_attempt_at: attemptedAt })
      .eq("id", lead.id)
      .eq("stage", "raw")
      .eq("status", "active")
      .select("id");
    // No row means the lead moved on mid-probe, so the throw is not this lead's
    // failure. Counting it as an error would flip the run to `partial` and fire a
    // spurious safety alert. A failed stamp is the opposite case and must stay an
    // error: the lead is still raw and now unstamped, so reporting it as benign
    // would hide both the write failure and a lead sitting at the queue head.
    if (!stampErr && !data?.length) return { status: "superseded" };
    return { status: "error", reason: e?.message ?? "threw" };
  }

  await flushContactApiCalls(admin, runId, lead.id, log);

  // Never let a rejected marketplace address (e.g. concierge@knowde.com) survive
  // as the outreach email via the raw-scout fallback below.
  const priorScoutEmail = lead.payload?.supplier_contact_email ?? null;
  const scoutEmailFallback = isAggregatorEmail(priorScoutEmail) ? null : priorScoutEmail;

  // Drop any marker left by an earlier block: a lead that has since become
  // reachable must not be promoted still carrying "held". The block path below
  // re-adds it when this attempt also fails.
  //
  // Also strip any prior material-relevance flag/note. We re-derive it from this
  // run's assessment below (re-added only when still not relevant), so a lead that
  // now matches gets its flag cleared and re-runs never double-stamp it.
  const {
    enrichment_blocked_reason: _priorBlock,
    relevance_flag: _priorRelFlag,
    relevance_note: _priorRelNote,
    ...priorPayload
  } = lead.payload ?? {};

  // A marketplace-trust penalty (Send-Inquiry / price-range / low-trust-China
  // listing) down-ranks the lead's confidence so it sorts to the bottom of the
  // confidence-ordered enrichment/outreach queues. Soft only: it never blocks
  // outreach or drops the lead. No-op when the lead was never confidence-scored.
  //
  // Anchor the reduction on the ORIGINAL (pre-penalty) confidence, stored once as
  // enrichment.confidence_base — otherwise a blocked marketplace lead that gets
  // re-enriched each run would subtract the penalty repeatedly and decay to zero.
  const penalty = result.marketplace_trust?.penalty ?? 0;
  const priorBase =
    typeof lead.payload?.enrichment?.confidence_base === "number"
      ? lead.payload.enrichment.confidence_base
      : typeof lead.confidence_score === "number"
      ? lead.confidence_score
      : null;
  const downrankedConfidence =
    penalty > 0 && priorBase != null ? Math.max(0, Math.round((priorBase - penalty) * 100) / 100) : null;
  const confidencePatch = downrankedConfidence != null ? { confidence_score: downrankedConfidence } : {};

  // Human-readable flag for low-trust marketplace listings (Alibaba, IndiaMART,
  // etc.) so ops can see at a glance in the Leads tab. Built from the marketplace
  // trust assessment signals.
  const marketplaceSourceNote = result.marketplace_trust?.is_low_trust_marketplace
    ? `Low confidence result from ${result.marketplace_trust.marketplace_host ?? "marketplace"}`
    : null;

  // Advisory material-relevance flag for importyeti/sourceready leads whose product
  // text shows zero overlap with the target material. Set exactly the same way as
  // marketplace_source_note: annotate only, never block or drop. Re-derived every
  // run (the prior flag was stripped above), so it stays idempotent.
  const relevancePatch =
    result.material_relevance && !result.material_relevance.relevant
      ? {
          relevance_flag: "material_capability_unverified" as const,
          relevance_note: result.material_relevance.note,
        }
      : {};

  const mergedPayload = {
    ...priorPayload,
    ...(marketplaceSourceNote ? { marketplace_source_note: marketplaceSourceNote } : {}),
    ...relevancePatch,
    enrichment: {
      website_probe: result.website_probe,
      email_check: result.email_check,
      contact: result.contact,
      tenkara_supplier: result.tenkara_supplier,
      legitimacy_check: result.legitimacy_check,
      marketplace_trust: result.marketplace_trust,
      material_relevance: result.material_relevance,
      aggregator_contact_email: result.aggregator_contact_email,
      completeness_score: result.completeness_score,
      completeness_factors: result.completeness_factors,
      // Preserve the pre-penalty confidence so re-runs stay idempotent.
      ...(downrankedConfidence != null ? { confidence_base: priorBase } : {}),
      enriched_at: attemptedAt,
      enrichment_run_id: runId,
    },
    supplier_contact_email: result.contact.email ?? scoutEmailFallback ?? null,
    // Extra reachable people at this supplier, CC'd on the outreach thread.
    additional_contacts: result.additional_contacts,
    supplier_phone: result.contact.phone ?? result.tenkara_supplier?.poc_phone ?? lead.payload?.supplier_phone ?? null,
    contact_url: result.contact.contact_url ?? lead.payload?.contact_url ?? null,
    supplier_country: lead.payload?.supplier_country ?? result.tenkara_supplier?.country ?? null,
    completeness_score: result.completeness_score,
    completeness_factors: result.completeness_factors,
  };

  // Provider product evidence with zero target-material overlap is a hard stop. This
  // is narrower than missing evidence: collectProductText returns empty when there is
  // nothing reliable to judge, and assessMaterialRelevance then remains relevant.
  if (result.material_relevance && !result.material_relevance.relevant) {
    const { data, error } = await admin
      .from("leads_in_flight")
      .update({
        stage: "terminal",
        status: "terminal",
        drop_reason: "provider_product_mismatch",
        payload: mergedPayload,
        last_enrichment_attempt_at: attemptedAt,
        ...confidencePatch,
      })
      .eq("id", lead.id)
      .eq("stage", "raw")
      .eq("status", "active")
      .select("id");
    if (error) return { status: "error", reason: error.message };
    return data?.length ? { status: "blocked", reason: "provider_product_mismatch" } : { status: "superseded" };
  }

  // Both writes re-assert the same predicate the batch selected on. The Control Room
  // can promote or drop a lead while this probe is in flight. Zero rows means someone
  // got there first, so this run must not overwrite the newer state.
  if (result.outreach_ready) {
    const { data, error } = await admin
      .from("leads_in_flight")
      .update({ stage: "enriched", payload: mergedPayload, last_enrichment_attempt_at: attemptedAt, ...confidencePatch })
      .eq("id", lead.id)
      .eq("stage", "raw")
      .eq("status", "active")
      .select("id");
    if (error) {
      await log(`Promote update failed for lead ${lead.id}: ${error.message}`, { step: "promote", data: { lead_id: lead.id } });
      return { status: "error", reason: error.message };
    }
    if (!data?.length) return { status: "superseded" };
    return { status: "promoted", completeness: result.completeness_score };
  }

  const reason = result.blocked_reason ?? "unknown";
  const { data, error } = await admin
    .from("leads_in_flight")
    .update({
      payload: { ...mergedPayload, enrichment_blocked_reason: reason },
      last_enrichment_attempt_at: attemptedAt,
      ...confidencePatch,
    })
    .eq("id", lead.id)
    .eq("stage", "raw")
    .eq("status", "active")
    .select("id");
  if (error) {
    await log(`Block update failed for lead ${lead.id}: ${error.message}`, { step: "block", data: { lead_id: lead.id } });
    return { status: "error", reason: error.message };
  }
  if (!data?.length) return { status: "superseded" };
  return { status: "blocked", reason };
}
