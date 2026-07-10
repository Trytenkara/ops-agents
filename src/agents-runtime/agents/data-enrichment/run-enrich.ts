import type { createAdminClient } from "@/lib/supabase/admin";
import { enrichLead, isAggregatorEmail, type RawLead } from "./enrich";

// Per-lead enrichment: run enrichLead(), merge the result into the lead payload,
// and either promote to stage=enriched or leave at raw with a blocked_reason.
// Shared by Agent 06's scheduled sweep and Agent 03's inline drain so both
// behave identically.

type Admin = ReturnType<typeof createAdminClient>;

export interface EnrichOutcome {
  status: "promoted" | "blocked" | "error";
  reason?: string;
  completeness?: number;
}

export async function enrichAndStageLead(
  lead: RawLead,
  deps: { admin: Admin; runId: string; log?: (msg: string, meta?: any) => Promise<void> | void }
): Promise<EnrichOutcome> {
  const { admin, runId } = deps;
  const log = deps.log ?? (async () => {});

  let result;
  try {
    result = await enrichLead(lead);
  } catch (e: any) {
    await log(`Enrichment threw for lead ${lead.id}: ${e?.message ?? e}`, { step: "enrich", data: { lead_id: lead.id } });
    return { status: "error", reason: e?.message ?? "threw" };
  }

  // Never let a rejected marketplace address (e.g. concierge@knowde.com) survive
  // as the outreach email via the raw-scout fallback below.
  const priorScoutEmail = lead.payload?.supplier_contact_email ?? null;
  const scoutEmailFallback = isAggregatorEmail(priorScoutEmail) ? null : priorScoutEmail;

  const mergedPayload = {
    ...(lead.payload ?? {}),
    enrichment: {
      website_probe: result.website_probe,
      email_check: result.email_check,
      contact: result.contact,
      tenkara_supplier: result.tenkara_supplier,
      aggregator_contact_email: result.aggregator_contact_email,
      completeness_score: result.completeness_score,
      enriched_at: new Date().toISOString(),
      enrichment_run_id: runId,
    },
    supplier_contact_email: result.contact.email ?? scoutEmailFallback ?? null,
    supplier_phone: result.contact.phone ?? result.tenkara_supplier?.poc_phone ?? lead.payload?.supplier_phone ?? null,
    contact_url: result.contact.contact_url ?? lead.payload?.contact_url ?? null,
    supplier_country: lead.payload?.supplier_country ?? result.tenkara_supplier?.country ?? null,
    completeness_score: result.completeness_score,
  };

  if (result.outreach_ready) {
    const { error } = await admin
      .from("leads_in_flight")
      .update({ stage: "enriched", payload: mergedPayload })
      .eq("id", lead.id);
    if (error) {
      await log(`Promote update failed for lead ${lead.id}: ${error.message}`, { step: "promote", data: { lead_id: lead.id } });
      return { status: "error", reason: error.message };
    }
    return { status: "promoted", completeness: result.completeness_score };
  }

  const reason = result.blocked_reason ?? "unknown";
  const { error } = await admin
    .from("leads_in_flight")
    .update({ payload: { ...mergedPayload, enrichment_blocked_reason: reason } })
    .eq("id", lead.id);
  if (error) {
    await log(`Block update failed for lead ${lead.id}: ${error.message}`, { step: "block", data: { lead_id: lead.id } });
    return { status: "error", reason: error.message };
  }
  return { status: "blocked", reason };
}
