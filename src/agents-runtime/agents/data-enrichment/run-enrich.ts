import type { createAdminClient } from "@/lib/supabase/admin";
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

  // Never let a rejected marketplace address (e.g. concierge@knowde.com) survive
  // as the outreach email via the raw-scout fallback below.
  const priorScoutEmail = lead.payload?.supplier_contact_email ?? null;
  const scoutEmailFallback = isAggregatorEmail(priorScoutEmail) ? null : priorScoutEmail;

  // Drop any marker left by an earlier block: a lead that has since become
  // reachable must not be promoted still carrying "held". The block path below
  // re-adds it when this attempt also fails.
  const { enrichment_blocked_reason: _priorBlock, ...priorPayload } = lead.payload ?? {};

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

  const mergedPayload = {
    ...priorPayload,
    enrichment: {
      website_probe: result.website_probe,
      email_check: result.email_check,
      contact: result.contact,
      tenkara_supplier: result.tenkara_supplier,
      legitimacy_check: result.legitimacy_check,
      marketplace_trust: result.marketplace_trust,
      aggregator_contact_email: result.aggregator_contact_email,
      completeness_score: result.completeness_score,
      completeness_factors: result.completeness_factors,
      // Preserve the pre-penalty confidence so re-runs stay idempotent.
      ...(downrankedConfidence != null ? { confidence_base: priorBase } : {}),
      enriched_at: attemptedAt,
      enrichment_run_id: runId,
    },
    supplier_contact_email: result.contact.email ?? scoutEmailFallback ?? null,
    supplier_phone: result.contact.phone ?? result.tenkara_supplier?.poc_phone ?? lead.payload?.supplier_phone ?? null,
    contact_url: result.contact.contact_url ?? lead.payload?.contact_url ?? null,
    supplier_country: lead.payload?.supplier_country ?? result.tenkara_supplier?.country ?? null,
    completeness_score: result.completeness_score,
    completeness_factors: result.completeness_factors,
  };

  // Both writes re-assert the same predicate the batch selected on. The Control Room
  // can promote or drop a lead (actions/leads.ts, actions/cases.ts,
  // actions/material-flags.ts) while this probe is in flight; without it the write
  // lands on top of that newer state. status matters as much as stage: dropLead sets
  // status='terminal' and leaves stage='raw', so a stage-only guard would resurrect a
  // dropped lead. Zero rows means someone got there first -- neither promote nor block.
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
