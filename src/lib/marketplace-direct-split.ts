import type { SupabaseClient } from "@supabase/supabase-js";
import { isAggregatorEmail } from "@/agents-runtime/agents/data-enrichment/enrich";
import { leadMarketKind } from "@/lib/lead-market";

type Admin = SupabaseClient<any, any, any>;

// Does this lead sit on the marketplace track today? Same test the outreach
// sweep uses, minus the direct-contact override, so a lead already split out
// (site_type "N") reads as direct here.
export function isMarketplaceLeadPayload(payload: Record<string, any> | null | undefined): boolean {
  const p = payload ?? {};
  const kind = leadMarketKind(p.site_type);
  return (
    kind === "marketplace" ||
    kind === "aggregator" ||
    (kind !== "direct" && !!p.aggregator) ||
    p.supplier_role === "Marketplace" ||
    p.supplier_role === "Reseller"
  );
}

export type DirectSplitResult =
  | { split: false; reason: string }
  | { split: true; directLeadId: string; reused: boolean };

// A marketplace or aggregator lead that answers from its own address has told us
// two separate things: the listing still exists (that is the price-index row) and
// the company behind it will deal with us by email (that is a direct supplier).
// Collapsing those into one row, which is what the in-place site_type flip did,
// destroyed the listing the price index publishes from and left the direct
// relationship carrying marketplace provenance. So keep the marketplace lead as
// it is and stand up a second, non-marketplace lead for the same supplier and
// material: same name, direct tag, its own quotes and its own comms.
export async function splitDirectLeadFromMarketplace(
  admin: Admin,
  opts: {
    leadId: string;
    contactEmail: string;
    conversationId?: string | null;
    draftRefId?: string | null;
    // Where the direct contact came from, for the audit trail on both rows.
    trigger: "email_reply" | "operator";
  },
): Promise<DirectSplitResult> {
  const email = opts.contactEmail.trim().toLowerCase();
  if (!email || isAggregatorEmail(email)) return { split: false, reason: "platform_address" };

  const { data: lead } = await admin
    .from("leads_in_flight")
    .select("id, org_id, supplier_id, supplier_name, material_id, material_name, source, confidence_score, assigned_operator_id, payload")
    .eq("id", opts.leadId)
    .maybeSingle();
  if (!lead) return { split: false, reason: "lead_missing" };

  const payload = (lead.payload ?? {}) as Record<string, any>;
  if (payload.direct_lead_id) return { split: false, reason: "already_split" };
  if (payload.origin_marketplace_lead_id) return { split: false, reason: "already_direct" };

  if (!isMarketplaceLeadPayload(payload)) return { split: false, reason: "not_marketplace" };

  // The seller may already be on file as a direct lead for this material (the
  // scout found the company itself, or an earlier reply on another listing split
  // it out). Reuse that row rather than stacking a second one.
  const { data: siblings } = await admin
    .from("leads_in_flight")
    .select("id, payload")
    .eq("org_id", lead.org_id)
    .eq("material_id", lead.material_id)
    .eq("status", "active");
  const existing = ((siblings ?? []) as any[]).find(
    (s) =>
      s.id !== lead.id &&
      String(s.payload?.supplier_contact_email ?? "").trim().toLowerCase() === email &&
      leadMarketKind(s.payload?.site_type) === "direct",
  );

  const now = new Date().toISOString();
  let directLeadId: string;
  if (existing) {
    directLeadId = existing.id;
  } else {
    const { data: inserted, error } = await admin
      .from("leads_in_flight")
      .insert({
        org_id: lead.org_id,
        // No supplier_id: the marketplace row owns the link to the Tenkara
        // supplier when it has one, and a name-only direct row is what every
        // other discovery path produces anyway.
        supplier_id: null,
        supplier_name: lead.supplier_name,
        material_id: lead.material_id,
        material_name: lead.material_name,
        // A reply means the conversation with this address is already live, so
        // enter past the cold-email sweep: Agent 04 must not send a first-contact
        // to an address that is mid-thread. An address an operator dug out of a
        // relay reply has no thread yet, so that one does want the cold email.
        stage: opts.trigger === "operator" ? "enriched" : "ready_for_outreach",
        status: "active",
        source: "marketplace_direct_contact",
        // A company that answers a sourcing inquiry by email is a better lead
        // than the anonymous listing it came from, but nothing about its
        // material fit is verified yet.
        confidence_score: Math.max(Number(lead.confidence_score ?? 0), 0.5),
        assigned_operator_id: lead.assigned_operator_id ?? null,
        payload: {
          inci_name: payload.inci_name ?? null,
          tenkara_org_id: payload.tenkara_org_id ?? null,
          supplier_website: payload.supplier_website ?? null,
          supplier_country: payload.supplier_country ?? null,
          site_type: "N",
          supplier_role: "Supplier",
          supplier_contact_email: opts.contactEmail.trim(),
          // Format is not in question: this address just sent us mail.
          enrichment: { contact: { email: opts.contactEmail.trim(), source: `${payload.aggregator ?? "marketplace"}_reply`, poc_name: payload.poc_name ?? null }, email_check: { format_valid: true, checked_at: now, source: "inbound_reply" } },
          // Provenance, not classification: where we found the company. Kept so
          // the card can say "direct, via ExportersIndia" and so nobody
          // re-discovers it off the same listing.
          aggregator: payload.aggregator ?? null,
          aggregator_direct_contact: true,
          origin_marketplace_lead_id: lead.id,
          origin_marketplace: {
            platform: payload.aggregator ?? null,
            site_type: payload.site_type ?? null,
            listing_url: payload.source_url ?? null,
            split_at: now,
            trigger: opts.trigger,
          },
          direct_thread: opts.conversationId ? { conversation_id: opts.conversationId, draft_reference_id: opts.draftRefId ?? null } : null,
          needs_contact_resolution: false,
          confidence_hint: "lead",
          confidence_reason:
            opts.trigger === "operator"
              ? `An operator pulled this supplier's own address out of a ${payload.aggregator ?? "marketplace"} reply, so we deal with them directly.`
              : `Replied from its own address to our ${payload.aggregator ?? "marketplace"} inquiry, so we deal with this supplier directly.`,
          relevance_tier: payload.relevance_tier ?? "Potential",
          scout_notes: `Direct supplier record split out of the ${payload.aggregator ?? "marketplace"} listing, reachable at ${opts.contactEmail.trim()}.`,
        },
      })
      .select("id")
      .single();
    if (error) return { split: false, reason: `insert_failed:${error.message}` };
    directLeadId = inserted.id;
  }

  // Re-read: the caller has been writing reply state onto this payload.
  const { data: fresh } = await admin.from("leads_in_flight").select("payload").eq("id", lead.id).maybeSingle();
  const mpPayload = ((fresh?.payload ?? payload) ?? {}) as Record<string, any>;
  await admin
    .from("leads_in_flight")
    .update({
      payload: {
        ...mpPayload,
        // Deliberately NOT setting supplier_contact_email here: the marketplace
        // row must stay un-cold-emailable so the two tracks never both write to
        // the same address. It keeps the listing and the price index; the direct
        // row keeps the conversation.
        direct_lead_id: directLeadId,
        yielded_direct_contact: { at: now, email: opts.contactEmail.trim(), trigger: opts.trigger, reused_existing_lead: !!existing },
        needs_contact_resolution: false,
      },
    })
    .eq("id", lead.id);

  return { split: true, directLeadId, reused: !!existing };
}
