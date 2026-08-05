import { randomUUID } from "crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { stageDraft } from "@/lib/draft-staging";
import { composeReply } from "@/lib/reply-drafter";
import { shipsToUsVerdict, type ShipsToUsAnnotation } from "@/lib/ships-to-us";
import { extractQuotesFromReplyText, type ExtractedQuote, type ReplyQuoteExtraction } from "@/lib/reply-quote-extract";
import { insertStagedQuotes, type StagedQuoteInput, type StagedQuoteSource } from "@/lib/staged-quotes";
import { normalizeToUsd } from "@/lib/fx";
import { classifyDocType, insertSupplierDocuments, type SupplierDocumentInput } from "@/lib/supplier-documents";
import { syncDocRequirementsMet } from "@/lib/document-requirements";
import { extractDocumentFields, isDocExtractableExt } from "@/lib/document-extract";
import { getTenkaraMessageAttachments, downloadTenkaraAttachment } from "@/lib/tenkara-attachments";
import { parseAttachmentBytes, deriveExt, isPricingCandidateExt } from "@/lib/attachment-parser";
import { getTenkaraConversationMessages } from "@/lib/tenkara";
import { postAgentAlert } from "@/lib/slack-alert";
import { parseTaggedRecipient } from "@/lib/inquiry-reply-tag";
import { isAggregatorEmail } from "@/agents-runtime/agents/data-enrichment/enrich";
import { splitDirectLeadFromMarketplace, isMarketplaceLeadPayload } from "@/lib/marketplace-direct-split";
import { upsertSupplierProfile } from "@/lib/supplier-profiles";
import { getClientShipTo } from "@/lib/tenkara-client-settings";
import { resolveMaterialGradeSpecs } from "@/lib/tenkara-names";
import {
  completenessFollowupEnabled,
  computeMissingApprovalFields,
  type MissingApprovalField,
} from "@/lib/quote-completeness";

// A "reply" from a mailer-daemon isn't the supplier — it's a delivery failure.
// Detect it so we never draft a reply to the daemon and can restart outreach.
function isBounce(senderAddr: string | null, subject: string | null): boolean {
  const a = (senderAddr ?? "").toLowerCase();
  const s = (subject ?? "").toLowerCase();
  if (/mailer-daemon|postmaster@|maildelivery|mail-daemon/.test(a)) return true;
  if (/undeliverable|delivery status notification|delivery (has )?failed|failure notice|returned mail|address not found|recipient.*(reject|not found)|message could not be delivered|mail delivery failed/.test(s)) return true;
  return false;
}

// Handles a Tenkara `message.received` webhook: a supplier replied on a
// conversation one of our agents originated. We match it back to the
// originating draft_references row, compose a reply (inline), and stage that
// reply as a new Tenkara draft in the same conversation for an operator to send.
//
// This IS Agent 08: Rod pushes us each inbound message instead of us polling an
// inbox, and replies go back into the same Tenkara conversation.

type Admin = ReturnType<typeof createAdminClient>;

export interface InboundMessage {
  conversation_id: string;
  message_id: string;
  in_reply_to_draft_id?: string | null;
  from: string;
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  received_at?: string | null;
  to_email?: string | null;
  email_account_id?: string | null;
}

export interface InboundResult {
  status: number;
  body: Record<string, any>;
}

// "Name <email>" → {name, address}; bare "email" → {address}.
function parseFrom(from: string): { name: string | null; address: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || null, address: m[2].trim() };
  return { name: null, address: from.trim() };
}

// Generic free-email domains — too common across unrelated suppliers to use for
// domain-based thread matching. Companies that use these are identified by their
// exact address (which is already in draft_id / thread_id lookups), not by domain.
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "yahoo.co.in",
  "ymail.com", "icloud.com", "me.com", "aol.com", "live.com", "msn.com",
  "protonmail.com", "proton.me", "qq.com", "163.com", "126.com", "sina.com",
]);

async function resolveInboundOrg(admin: Admin, msg: InboundMessage): Promise<{ orgId: string; accountKey: string; replyTag: string | null } | null> {
  let accountId = msg.email_account_id?.trim() || null;
  let toEmail = msg.to_email?.trim().toLowerCase() || null;

  if (!accountId && !toEmail) {
    const messages = await getTenkaraConversationMessages(msg.conversation_id);
    const inboundRecipient = [...messages].reverse().find((m) => m.to)?.to ?? null;
    toEmail = inboundRecipient?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? null;
  }

  // An inquiry-form reply arrives at a tagged address. orgs.tenkara_email_address
  // holds the plain inbox, so match on the base and carry the tag out for the
  // per-inquiry match below; without stripping it, the ilike misses and a reply
  // we deliberately routed here dead-letters as unassignable.
  const { base, tag } = parseTaggedRecipient(toEmail);
  const replyTag = tag;
  toEmail = base;

  let accountRows: any[] = [];
  let addressRows: any[] = [];
  if (accountId) {
    const { data, error } = await admin.from("orgs").select("id").eq("tenkara_email_account_id", accountId).limit(2);
    if (error) throw new Error(`org lookup by Tenkara account failed: ${error.message}`);
    accountRows = data ?? [];
  }
  if (toEmail) {
    const { data, error } = await admin.from("orgs").select("id").ilike("tenkara_email_address", toEmail).limit(2);
    if (error) throw new Error(`org lookup by Tenkara address failed: ${error.message}`);
    addressRows = data ?? [];
  }

  const accountOrg = accountRows.length === 1 ? accountRows[0].id : null;
  const addressOrg = addressRows.length === 1 ? addressRows[0].id : null;
  if (accountOrg && addressOrg && accountOrg !== addressOrg) throw new Error("Tenkara account and recipient resolve to different clients");
  const orgId = accountOrg ?? addressOrg;
  if (!orgId) return null;
  return { orgId, accountKey: accountId ?? toEmail!, replyTag };
}

export async function handleInboundReply(admin: Admin, msg: InboundMessage): Promise<InboundResult> {
  let inboundOrg: { orgId: string; accountKey: string; replyTag: string | null } | null = null;
  try {
    inboundOrg = await resolveInboundOrg(admin, msg);
  } catch (error: any) {
    return { status: 503, body: { error: "inbound_org_lookup_failed", detail: error?.message ?? String(error) } };
  }

  // Marketplace signup-confirmation emails arrive on these same inboxes but are
  // not supplier replies — detect, click the confirm link, activate the account,
  // and stop (no reply draft, no triage case). Returns null for everything else.
  const { maybeConfirmMarketplaceSignup } = await import("@/lib/marketplace-confirm");
  const confirmed = await maybeConfirmMarketplaceSignup(admin, msg, inboundOrg);
  if (confirmed) return confirmed;
  // 1. Find the originating draft (the one our agent posted that this replies to).
  let ref: any = null;

  // A plus-tag is the strongest signal we have: we minted it for exactly one
  // inquiry, so it identifies the outreach even when the seller replies from an
  // address we have never seen and starts a brand-new thread (the normal case for
  // a platform inquiry form, which is the only channel these sellers have).
  let replyTagMatch = false;
  if (inboundOrg?.replyTag) {
    const { data: tagRef, error } = await admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata")
      .eq("email_client", "rod_app")
      .eq("org_id", inboundOrg.orgId)
      .eq("metadata->>reply_tag", inboundOrg.replyTag)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { status: 503, body: { error: "reply_tag_match_failed", detail: error.message } };
    if (tagRef) {
      ref = tagRef;
      replyTagMatch = true;
    }
  }

  if (!ref && msg.in_reply_to_draft_id) {
    let lookup = admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata")
      .eq("draft_id", msg.in_reply_to_draft_id)
      .eq("email_client", "rod_app");
    if (inboundOrg) lookup = lookup.eq("org_id", inboundOrg.orgId);
    const { data, error } = await lookup.maybeSingle();
    if (error) return { status: 503, body: { error: "draft_match_failed", detail: error.message } };
    ref = data;
  }
  if (!ref) {
    let lookup = admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata")
      .eq("thread_id", msg.conversation_id)
      .eq("email_client", "rod_app");
    if (inboundOrg) lookup = lookup.eq("org_id", inboundOrg.orgId);
    const { data, error } = await lookup.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) return { status: 503, body: { error: "thread_match_failed", detail: error.message } };
    ref = data;
  }

  // Operator-attached alternate email: resolve directly to the existing supplier
  // thread before domain/address fallbacks, including generic personal domains.
  let aliasAddressMatch = false;
  if (!ref && inboundOrg) {
    const fromAddr = parseFrom(msg.from).address.toLowerCase();
    if (fromAddr) {
      const { data: alias, error: aliasError } = await admin
        .from("supplier_email_aliases")
        .select("draft_ref_id, thread_id")
        .eq("org_id", inboundOrg.orgId)
        .eq("email", fromAddr)
        .eq("claim_status", "attached")
        .maybeSingle();
      if (aliasError) return { status: 503, body: { error: "alias_match_failed", detail: aliasError.message } };
      if (alias) {
        let aliasRefQuery = admin
          .from("draft_references")
          .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata")
          .eq("org_id", inboundOrg.orgId)
          .eq("email_client", "rod_app");
        aliasRefQuery = alias.draft_ref_id ? aliasRefQuery.eq("id", alias.draft_ref_id) : aliasRefQuery.eq("thread_id", alias.thread_id);
        const { data: aliasRef } = await aliasRefQuery.order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (aliasRef) {
          ref = aliasRef;
          aliasAddressMatch = true;
        }
      }
    }
  }

  // Fallback: sender-domain matching for new-contact / thread-split scenarios.
  // A supplier sometimes redirects us to a colleague who opens a FRESH email with
  // a new subject — a brand-new Tenkara thread. Neither draft_id nor thread_id
  // match our records, but the sender's corporate domain still ties back to the
  // same supplier. We only attempt this for non-generic company domains (gmail,
  // outlook, etc. are excluded) and only when every candidate belongs to exactly
  // one supplier (safe, unambiguous match).
  //
  // Side-effect: stageDraft below places the reply into the new conversation, so
  // subsequent messages in this new thread WILL match by thread_id automatically —
  // this fix is self-propagating.
  let domainMatchFallback = false;
  if (!ref && inboundOrg) {
    const fromAddr = parseFrom(msg.from).address.toLowerCase();
    const senderDomain = fromAddr.split("@")[1] ?? null;
    if (senderDomain && !GENERIC_EMAIL_DOMAINS.has(senderDomain)) {
      const { data: domainRefs, error } = await admin
        .from("draft_references")
        .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata")
        .eq("email_client", "rod_app")
        .eq("org_id", inboundOrg.orgId)
        .filter("metadata->>supplier_contact_email", "ilike", `%@${senderDomain}`)
        .order("created_at", { ascending: false });
      if (error) return { status: 503, body: { error: "domain_match_failed", detail: error.message } };
      if (domainRefs && domainRefs.length > 0) {
        const uniqueTargets = new Set(domainRefs.map((r: any) => `${r.supplier_id ?? ""}:${r.material_id ?? ""}`));
        if (uniqueTargets.size === 1 && domainRefs[0]?.supplier_id && domainRefs[0]?.material_id) {
          ref = domainRefs[0];
          domainMatchFallback = true;
        }
      }
    }
  }

  // Fallback: EXACT sender-ADDRESS matching. The domain fallback above deliberately
  // skips generic free-email domains (gmail/outlook/...) because a whole domain is
  // far too broad to trust there. But the FULL address is unambiguous even on a
  // generic domain, so we can safely match a supplier who replies from the very
  // gmail/personal address we already emailed (or whose draft_id/thread linkage
  // broke). We apply it regardless of domain, but only accept a result that
  // resolves to exactly ONE supplier (unambiguous single-supplier match).
  let exactAddressMatch = false;
  if (!ref && inboundOrg) {
    const fromAddr = parseFrom(msg.from).address;
    if (fromAddr) {
      const { data: addrRefs, error } = await admin
        .from("draft_references")
        .select("id, org_id, supplier_id, material_id, subject, assigned_operator, metadata")
        .eq("email_client", "rod_app")
        .eq("org_id", inboundOrg.orgId)
        .filter("metadata->>supplier_contact_email", "ilike", fromAddr)
        .order("created_at", { ascending: false });
      if (error) return { status: 503, body: { error: "address_match_failed", detail: error.message } };
      if (addrRefs && addrRefs.length > 0) {
        const uniqueTargets = new Set(addrRefs.map((r: any) => `${r.supplier_id ?? ""}:${r.material_id ?? ""}`));
        if (uniqueTargets.size === 1 && addrRefs[0]?.supplier_id && addrRefs[0]?.material_id) {
          ref = addrRefs[0];
          exactAddressMatch = true;
        }
      }
    }
  }

  // Still unmatched: no draft_id, thread_id, domain, or exact-address match. Rod
  // pre-filters to conversations our agents touched, so a true miss is rare, but
  // silently dropping it means an operator never sees a supplier (or client) who
  // replied out-of-thread. Record it instead of dropping (alert + triage case).
  if (!ref) return await recordUnmatchedInbound(admin, msg, inboundOrg);

  // 2. Idempotency: if we already drafted a reply for this inbound message, no-op.
  const { data: dupe } = await admin
    .from("draft_references")
    .select("id")
    .eq("email_client", "rod_app")
    .eq("metadata->>in_reply_to_message_id", msg.message_id)
    .maybeSingle();
  if (dupe) return { status: 200, body: { deduped: true, draft_ref_id: dupe.id } };

  const refMeta = (ref.metadata ?? {}) as Record<string, any>;
  const from = parseFrom(msg.from);
  const bounceLeadId = refMeta.lead_id as string | undefined;

  // 2b. Bounce / delivery failure. The inbound is a mailer-daemon, not the
  //     supplier — never draft a reply to it. Retire the bounced draft (so a
  //     requeued lead is treated as fresh first contact), alert ops, and open a
  //     manual-outreach case an operator resolves by entering a working email
  //     (addSupplierEmailToCase requeues the lead to restart outreach).
  if (isBounce(from.address, msg.subject ?? null)) {
    if (refMeta.flow_status === "bounced") return { status: 200, body: { deduped: true, reason: "already_bounced" } };
    const supplierLabel = refMeta.supplier_name ?? ref.supplier_id ?? "a supplier";
    await admin
      .from("draft_references")
      .update({
        status: "superseded",
        metadata: { ...refMeta, flow_status: "bounced", bounced: { at: new Date().toISOString(), from: from.address, needs_new_email: true } },
      })
      .eq("id", ref.id);
    await postAgentAlert(
      `:warning: *Bounce* on outreach to *${supplierLabel}*. The email didn't deliver — add a working email on the case to restart outreach.`
    );
    if (bounceLeadId) {
      const { data: existingCase } = await admin
        .from("cases")
        .select("id")
        .eq("type", "manual_outreach")
        .eq("status", "open")
        .eq("metadata->>lead_id", bounceLeadId)
        .maybeSingle();
      if (!existingCase) {
        await admin.from("cases").insert({
          org_id: ref.org_id,
          type: "manual_outreach",
          status: "open",
          supplier_id: ref.supplier_id,
          material_id: ref.material_id,
          assigned_operator: ref.assigned_operator,
          recommended_action: `Outreach to ${supplierLabel} bounced (${from.address}). Enter a working email to restart outreach.`,
          metadata: {
            source: "tenkara-inbound-bounce",
            lead_id: bounceLeadId,
            supplier_name: refMeta.supplier_name ?? null,
            bounced_from: from.address,
            bounced_at: new Date().toISOString(),
          },
        });
      }
    }
    return { status: 200, body: { bounced: true, draft_ref_id: ref.id } };
  }

  // Advance the pipeline board unless the thread is already further along, so a
  // late or duplicate inbound can't walk /work backwards.
  const ADVANCED = ["responded", "price_captured", "finalized", "closed_declined"];
  const flowAt = (s: string) => (ADVANCED.includes(refMeta.flow_status) ? refMeta.flow_status : s);

  // 3. Stamp reply_detected on the originating draft (mirrors Agent 08).
  // Held in a const so the final step-8 update (which also spreads refMeta) can
  // re-apply it — otherwise step 8's stale-refMeta spread clobbers it back to null.
  const replyDetected = {
    detected_at: new Date().toISOString(),
    source: "tenkara_webhook",
    reply_message_id: msg.message_id,
    reply_conversation_id: msg.conversation_id,
    reply_sender_email: from.address,
    reply_sender_name: from.name,
    reply_subject: msg.subject ?? null,
    // Set when a new contact started a fresh thread and we matched via sender domain.
    // The actual reply draft is staged into the new conversation; this flag is for audit.
    domain_match_fallback: domainMatchFallback || undefined,
    // Set when we matched on the exact full sender address (e.g. a supplier replying
    // from the same gmail/personal address we emailed). Audit flag only.
    exact_address_match: exactAddressMatch || undefined,
    alias_address_match: aliasAddressMatch || undefined,
    // Matched on the plus-tag we gave a platform inquiry form. Audit flag only.
    reply_tag_match: replyTagMatch || undefined,
  };
  await admin
    .from("draft_references")
    .update({
      metadata: {
        ...refMeta,
        flow_status: flowAt("reply_received"),
        reply_detected: replyDetected,
      },
    })
    .eq("id", ref.id);

  // 4. Pull lead context for a better reply (supplier/material/contact names).
  let leadId = refMeta.lead_id as string | undefined;
  let leadRow: any = null;
  if (leadId) {
    const { data } = await admin
      .from("leads_in_flight")
      .select("payload, supplier_name, material_name")
      .eq("id", leadId)
      .maybeSingle();
    leadRow = data;
    const leadPayload = (leadRow?.payload as any) ?? {};
    let escalatedRelay: { at: string; relay_from: string } | null = null;
    // A seller on the marketplace track has just written to us from its own
    // address, which makes it two things at once: the listing the price index
    // publishes from, and a supplier that deals with us directly. Split the
    // direct half onto its own lead and hand this conversation over to it, so
    // the quote lands as a direct price and every later message belongs to the
    // direct record instead of the listing.
    if (isMarketplaceLeadPayload(leadPayload) && !isAggregatorEmail(from.address) && !leadPayload.direct_lead_id) {
      const split = await splitDirectLeadFromMarketplace(admin, {
        leadId,
        contactEmail: from.address,
        conversationId: msg.conversation_id,
        draftRefId: ref.id,
        trigger: "email_reply",
      });
      if (split.split) {
        // Everything below (reply marker, captured price, staged detail) writes
        // to leadId, and the draft keeps pointing at it for the next inbound.
        leadId = split.directLeadId;
        refMeta.lead_id = split.directLeadId;
        const { data: directRow } = await admin
          .from("leads_in_flight")
          .select("payload, supplier_name, material_name")
          .eq("id", leadId)
          .maybeSingle();
        if (directRow) leadRow = directRow;
      }
    } else if (
      leadPayload.aggregator &&
      !leadPayload.supplier_contact_email &&
      !leadPayload.direct_contact_escalated &&
      !leadPayload.direct_lead_id
    ) {
      // The seller answered, but through the platform's own relay address, so we
      // still have no channel of our own. A platform inquiry form is one-shot (no
      // back-and-forth), so this thread cannot be continued and no amount of
      // retrying changes that: it needs an operator to read the reply and pull out
      // a real address. manual_outreach is the right case type because its
      // resolver (addSupplierEmailToCase) requeues the lead for normal outreach.
      escalatedRelay = { at: new Date().toISOString(), relay_from: from.address };
      const sellerLabel = leadRow?.supplier_name ?? refMeta.supplier_name ?? "an aggregator seller";
      const { data: openCase } = await admin
        .from("cases")
        .select("id")
        .eq("type", "manual_outreach")
        .eq("status", "open")
        .eq("metadata->>lead_id", leadId)
        .maybeSingle();
      if (!openCase) {
        await admin.from("cases").insert({
          org_id: ref.org_id,
          type: "manual_outreach",
          status: "open",
          supplier_id: ref.supplier_id,
          material_id: ref.material_id,
          assigned_operator: ref.assigned_operator,
          recommended_action: `${sellerLabel} replied via ${leadPayload.aggregator} (${from.address}) without giving a direct address. Read the reply and enter their own email to continue off-platform.`,
          metadata: {
            source: "aggregator-inquiry-no-direct-contact",
            lead_id: leadId,
            supplier_name: sellerLabel,
            aggregator: leadPayload.aggregator,
            relay_from: from.address,
            reply_conversation_id: msg.conversation_id,
          },
        });
        await postAgentAlert(
          `:mailbox: *${sellerLabel}* replied through ${leadPayload.aggregator} instead of from its own address, so we still have no direct contact. Open the case and add their email to continue.`
        );
      }
    }
    // Reply marker last, and onto whichever lead now owns the conversation: the
    // direct row when we just split, the original otherwise. Merged over a fresh
    // read of that row rather than the pre-split payload.
    const { data: ownerRow } = await admin.from("leads_in_flight").select("payload").eq("id", leadId).maybeSingle();
    await admin
      .from("leads_in_flight")
      .update({
        payload: {
          ...(((ownerRow?.payload ?? leadRow?.payload) ?? {}) as Record<string, any>),
          ...(escalatedRelay ? { direct_contact_escalated: escalatedRelay } : {}),
          supplier_reply: {
            replied_at: msg.received_at ?? new Date().toISOString(),
            reply_message_id: msg.message_id,
            reply_conversation_id: msg.conversation_id,
            source: "tenkara_webhook",
          },
        },
      })
      .eq("id", leadId);
  }

  const MAX_REPLY_TURNS = 8;
  const { data: conversationRefs } = await admin
    .from("draft_references")
    .select("metadata")
    .eq("email_client", "rod_app")
    .eq("org_id", ref.org_id)
    .eq("thread_id", msg.conversation_id);
  const currentTurns = Math.max(
    Number(refMeta.reply_turns ?? 0),
    ...((conversationRefs ?? []) as any[]).map((row) => Number((row.metadata ?? {}).reply_turns ?? 0)),
  );

  // Without an Anthropic key we can still record the reply; just don't auto-draft.
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: 200, body: { reply_detected: true, drafted: false, reason: "no_anthropic_key" } };
  }

  // 4b. Capture supplier pricing into staged_quotes for ops review — from the
  // reply body AND from file attachments (PDF quotes, Excel/CSV price lists,
  // photographed price sheets). Best-effort: extraction must never block the
  // reply draft.
  let quotesStaged = 0;
  let bodyExtraction: ReplyQuoteExtraction = {
    quotes: [],
    details: {
      material_name: null, case_size: null, unit_of_measurement: null, case_type: null,
      case_length: null, case_width: null, case_height: null, dimensions_unit: null, case_weight: null,
      lead_time_days: null, lead_time_text: null, moq_quantity: null, moq_unit: null, payment_terms: null,
      poc_name: null, poc_email: null, poc_phone: null, shipping_address: null, shipping_terms: null,
      shipping_email: null, billing_email: null, billing_poc_name: null,
    },
    declined: false,
    shipsToUs: null,
    shipsToUsEvidence: null,
  };
  // Non-inline files the supplier attached to THIS reply. Surfaced to the reply
  // drafter so it acknowledges them instead of insisting the attachment "didn't
  // come through" and asking the supplier to resend it.
  let receivedAttachments: { name: string; pricingExtracted: boolean }[] = [];
  try {
    // Each captured line tagged with where it came from, so the staged row and
    // the lead headline can tell body text from an attached price sheet.
    const captured: {
      q: ExtractedQuote;
      source: StagedQuoteSource;
      attachmentName: string | null;
      attachmentUrl: string | null;
    }[] = [];

    // Inline: prefer the HTML body because suppliers put price ladders in tables.
    // Detail-only replies (MOQ, lead time, terms, packaging) are persisted below
    // even when no price line is present.
    bodyExtraction = await extractQuotesFromReplyText(msg.body_html || msg.body_text);
    for (const q of bodyExtraction.quotes) {
      captured.push({ q, source: "email_body", attachmentName: null, attachmentUrl: null });
    }

    // Attachments: real (non-inline) pricing-candidate files on the inbound
    // message. Inline images are signature logos, not price sheets — skip them.
    const attachments = await getTenkaraMessageAttachments(msg.conversation_id, msg.message_id);
    const nonInline = attachments.filter((a) => !a.is_inline);
    receivedAttachments = nonInline.map((a) => ({ name: a.filename ?? "attachment", pricingExtracted: false }));
    // Bytes per attachment index, shared with the document pass below so a file
    // that both passes want is pulled off Tenkara once, not twice.
    const attBytes: (Buffer | null | undefined)[] = new Array(nonInline.length);
    for (let i = 0; i < nonInline.length; i++) {
      const att = nonInline[i];
      const ext = deriveExt(att.filename, att.content_type);
      if (!isPricingCandidateExt(ext, att.size_bytes)) continue;
      const buf = await downloadTenkaraAttachment(att);
      attBytes[i] = buf;
      if (!buf) continue;
      const qs = await parseAttachmentBytes(buf, att.filename, ext);
      if (qs.length) receivedAttachments[i].pricingExtracted = true;
      for (const q of qs) {
        captured.push({ q, source: "attachment", attachmentName: att.filename, attachmentUrl: att.download_url });
      }
    }

    // 4c. Record the qualification documents the supplier attached (CoA, SDS,
    //     certs, statements, ...) so The bench can show received-vs-required.
    //     Classified from filename/type; a file that yielded price lines is a
    //     price_sheet. Best-effort — never blocks the reply or pricing capture.
    try {
      const docRows: SupplierDocumentInput[] = [];
      for (let i = 0; i < nonInline.length; i++) {
        const att = nonInline[i];
        const docType = classifyDocType(att.filename, att.content_type, receivedAttachments[i]?.pricingExtracted ?? false);

        // Parse qualification fields out of the doc (CoA lot/assay/expiry, cert
        // validity, ...). Skip price sheets only, since the pricing pass above
        // already read those. 'other' is still parsed: the classifier falls back
        // to it whenever a filename doesn't announce its type, so skipping it
        // silently dropped fields off documents that did carry them.
        // Per-doc best-effort so one bad file doesn't drop the rest.
        let extracted: Record<string, any> | null = null;
        let expiresOn: string | null = null;
        // Downloaded once and used twice: to parse fields, and to keep a copy.
        // Tenkara's download_url needs a bearer token, so the stored bytes are
        // the only thing an operator can actually open from the bench.
        let bytes: Buffer | null = attBytes[i] ?? null;
        if (attBytes[i] === undefined) {
          try {
            bytes = await downloadTenkaraAttachment(att);
            attBytes[i] = bytes;
          } catch {
            /* per-doc download best-effort */
          }
        }
        if (bytes && docType !== "price_sheet") {
          const ext = deriveExt(att.filename, att.content_type);
          if (isDocExtractableExt(ext)) {
            try {
              const res = await extractDocumentFields(bytes, docType, ext);
              if (res) {
                extracted = res.fields;
                expiresOn = res.expires_on;
              }
            } catch {
              /* per-doc extraction best-effort */
            }
          }
        }

        docRows.push({
          orgId: ref.org_id,
          supplierId: ref.supplier_id,
          supplierName: leadRow?.supplier_name ?? null,
          materialId: ref.material_id,
          docType,
          fileName: att.filename ?? null,
          contentType: att.content_type ?? null,
          sizeBytes: att.size_bytes ?? null,
          sourceConversationId: msg.conversation_id,
          sourceMessageId: msg.message_id,
          sourceUrl: att.download_url ?? null,
          extracted,
          expiresOn,
          bytes,
          sourceKind: "email",
          // A supplier attaching a document to their own reply is issuing it,
          // even when the PDF was authored by their upstream manufacturer.
          supplierIssued: true,
        });
      }
      if (docRows.length) {
        await insertSupplierDocuments(admin, docRows);
        if (ref.org_id) await syncDocRequirementsMet(admin, ref.org_id);
      }
    } catch {
      /* doc capture is best-effort */
    }

    if (captured.length) {
      const staged: StagedQuoteInput[] = captured.map(({ q, source, attachmentName, attachmentUrl }) => ({
        orgId: ref.org_id,
        runId: null,
        source,
        sourceConversationId: msg.conversation_id,
        sourceMessageId: msg.message_id,
        sourceAttachmentName: attachmentName,
        sourceAttachmentUrl: attachmentUrl,
        supplierId: ref.supplier_id,
        supplierName: q.supplier_name ?? leadRow?.supplier_name ?? null,
        materialId: ref.material_id,
        materialName: q.material_name ?? leadRow?.material_name ?? null,
        price: q.price,
        caseSize: q.case_size,
        unitPriceGapReason: q.unit_price_gap_reason ?? null,
        unitOfMeasurement: q.unit_of_measurement,
        currency: q.currency,
        grade: q.grade,
        leadTimeDays: q.lead_time_days ?? null,
        leadTimeText: q.lead_time_text ?? null,
        moqQuantity: q.moq_quantity ?? null,
        moqUnit: q.moq_unit ?? null,
        paymentTerms: q.payment_terms ?? null,
        confidence: q.confidence,
        extractionNotes: q.notes,
        rawExtract: q as any,
      }));
      const res = await insertStagedQuotes(admin, staged);
      quotesStaged = res.inserted;

      // Mirror the freshest captured price/grade onto the lead so the Leads tab
      // shows the returned quote, not just a "supplier replied" marker. Lowest
      // per-unit line across body + attachments is the headline; ops refines.
      if (leadId && leadRow) {
        // Normalize each captured line to USD before ranking, so the "lowest
        // per-unit" headline compares like currencies (a raw ₹ line must not win
        // against a real USD line) and the value mirrored onto the lead is USD,
        // not an unconverted foreign number. Foreign lines with no reachable rate
        // keep their listed currency so the Leads tab labels them honestly.
        const priced: Array<{
          price: number | null;
          case_size: number | null;
          unit_price: number | null;
          unit_of_measurement: string | null;
          currency: string | null;
          grade: string | null;
          source: string;
        }> = [];
        for (const c of captured) {
          if (c.q.price == null) continue;
          const norm = await normalizeToUsd(c.q.currency);
          const price = norm.status === "converted" ? norm.convert(c.q.price) : c.q.price;
          const case_size = c.q.case_size;
          priced.push({
            price,
            case_size,
            unit_price: price != null && case_size ? price / case_size : price,
            unit_of_measurement: c.q.unit_of_measurement,
            currency: norm.status === "converted" ? "USD" : c.q.currency ?? null,
            grade: c.q.grade,
            source: c.source,
          });
        }
        priced.sort((a, b) => (a.unit_price ?? Infinity) - (b.unit_price ?? Infinity));
        if (priced.length) {
          const best = priced[0];
          // Re-read so we merge onto the supplier_reply marker written above
          // instead of clobbering it with the stale pre-marker payload.
          const { data: fresh } = await admin
            .from("leads_in_flight")
            .select("payload")
            .eq("id", leadId)
            .maybeSingle();
          const payload = (fresh?.payload as any) ?? (leadRow.payload as any) ?? {};
          payload.supplier_reply = {
            ...(payload.supplier_reply ?? {}),
            captured_price: best.price,
            captured_case_size: best.case_size,
            captured_unit_price: best.unit_price,
            captured_unit_of_measurement: best.unit_of_measurement,
            captured_currency: best.currency ?? "USD",
            captured_grade: best.grade ?? null,
            captured_at: msg.received_at ?? new Date().toISOString(),
            captured_source: best.source === "attachment" ? "reply_attachment" : "reply_extract",
          };
          await admin.from("leads_in_flight").update({ payload }).eq("id", leadId);
        }
      }
    }

    const d = bodyExtraction.details;
    const normalizeMaterial = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const statedMaterial = normalizeMaterial(d.material_name);
    const threadMaterial = normalizeMaterial(leadRow?.material_name);
    const detailMaterialMatches = !statedMaterial || !threadMaterial || statedMaterial === threadMaterial || statedMaterial.includes(threadMaterial) || threadMaterial.includes(statedMaterial);
    const hasQuoteDetails = detailMaterialMatches && [d.case_size, d.unit_of_measurement, d.case_type, d.case_length, d.case_width, d.case_height, d.dimensions_unit, d.case_weight, d.lead_time_days, d.lead_time_text, d.moq_quantity, d.moq_unit, d.payment_terms].some((value) => value != null && value !== "");
    // Supplier identity here cannot be an id equality test: discovery hands most
    // leads over name-only, so both the draft pointer and the staged quote row
    // are routinely name-only too (1 of 34 staged rows carries a supplier_id).
    // Requiring ref.supplier_id AND matching it against staged_quotes.supplier_id
    // meant this merge never ran for ~3 of every 4 reply threads, so lead time,
    // MOQ, terms and case dims the supplier stated in prose were dropped.
    const replySupplierName = leadRow?.supplier_name ?? (refMeta.supplier_name as string | undefined) ?? from.name ?? null;
    const supplierKey = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
    const wantSupplierKey = supplierKey(replySupplierName);
    if (hasQuoteDetails && ref.org_id && ref.material_id && (ref.supplier_id || wantSupplierKey)) {
      const { data: quoteRows, error: quoteReadError } = await admin
        .from("staged_quotes")
        .select("id, raw_extract, case_dimensions, dim_source, supplier_id, supplier_name")
        .eq("org_id", ref.org_id)
        .eq("material_id", ref.material_id)
        .not("status", "eq", "dismissed")
        .order("created_at", { ascending: false })
        .limit(20);
      if (quoteReadError) throw quoteReadError;
      let quote =
        (quoteRows ?? []).find(
          (q: any) =>
            (!!ref.supplier_id && q.supplier_id === ref.supplier_id) ||
            (!!wantSupplierKey && supplierKey(q.supplier_name) === wantSupplierKey)
        ) ?? null;
      if (!quote) {
        const { data: inserted, error: insertError } = await admin
          .from("staged_quotes")
          .insert({
            org_id: ref.org_id,
            source: "email_body",
            source_conversation_id: msg.conversation_id,
            source_message_id: msg.message_id,
            supplier_id: ref.supplier_id,
            supplier_name: replySupplierName,
            material_id: ref.material_id,
            material_name: leadRow?.material_name ?? d.material_name ?? null,
            price: null,
            confidence: "needs_review",
            raw_extract: { detail_intake: true },
            status: "pending_review",
          })
          .select("id, raw_extract, case_dimensions, dim_source, supplier_id, supplier_name")
          .single();
        if (insertError) throw insertError;
        quote = inserted;
      }

      const priorRaw = (quote.raw_extract ?? {}) as Record<string, any>;
      const supplierDims = { ...(priorRaw.supplier_dimensions ?? {}) };
      if (d.case_length != null) supplierDims.length = d.case_length;
      if (d.case_width != null) supplierDims.width = d.case_width;
      if (d.case_height != null) supplierDims.height = d.case_height;
      if (d.dimensions_unit) supplierDims.unit = d.dimensions_unit;
      if (d.case_weight != null) supplierDims.packaging_case_weight = d.case_weight;

      const detailPatch: Record<string, any> = {
        raw_extract: {
          ...priorRaw,
          supplier_dimensions: supplierDims,
          supplier_case_type: d.case_type ?? priorRaw.supplier_case_type ?? null,
          last_detail_message_id: msg.message_id,
        },
      };
      if (d.case_size != null) detailPatch.case_size = d.case_size;
      if (d.unit_of_measurement) detailPatch.unit_of_measurement = d.unit_of_measurement;
      if (d.case_type) detailPatch.case_type = d.case_type;
      if (d.lead_time_days != null) detailPatch.lead_time_days = d.lead_time_days;
      if (d.lead_time_text) detailPatch.lead_time_text = d.lead_time_text;
      if (d.moq_quantity != null) detailPatch.moq_quantity = d.moq_quantity;
      if (d.moq_unit) detailPatch.moq_unit = d.moq_unit;
      if (d.payment_terms) detailPatch.payment_terms = d.payment_terms;
      const completeDims = supplierDims.length != null && supplierDims.width != null && supplierDims.height != null && !!supplierDims.unit && supplierDims.packaging_case_weight != null;
      if (completeDims) {
        detailPatch.case_dimensions = supplierDims;
        detailPatch.dim_source = "supplier";
      }
      const { error: quoteUpdateError } = await admin.from("staged_quotes").update(detailPatch).eq("id", quote.id);
      if (quoteUpdateError) throw quoteUpdateError;
    }

    const profilePatch: Record<string, any> = {};
    for (const key of ["poc_name", "poc_email", "poc_phone", "shipping_address", "shipping_terms", "shipping_email", "billing_email", "billing_poc_name"] as const) {
      if (d[key]) profilePatch[key] = d[key];
    }
    if (d.payment_terms) {
      const net = d.payment_terms.match(/\bnet\s*(\d{1,3})\b/i);
      const upfront = d.payment_terms.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:upfront|deposit|prepaid)/i);
      if (net) profilePatch.payment_net_days = Number(net[1]);
      if (upfront) profilePatch.payment_upfront_pct = Number(upfront[1]);
      profilePatch.payment_completion = d.payment_terms;
    }
    // Same name-only reality as the quote merge above: a supplier_profiles row
    // keys on org + (supplier_id OR name), so an absent id must not drop the
    // contact/shipping/billing details the supplier just gave us.
    if (Object.keys(profilePatch).length && ref.org_id && (ref.supplier_id || replySupplierName)) {
      const profile = await upsertSupplierProfile(
        admin,
        ref.org_id,
        ref.supplier_id,
        replySupplierName ?? ref.supplier_id!,
      );
      const { error: profileUpdateError } = await admin.from("supplier_profiles").update(profilePatch).eq("id", profile.id);
      if (profileUpdateError) throw profileUpdateError;
    }
  } catch {
    // Reply drafting proceeds even when quote/profile persistence fails.
  }

  // Whether they ship to the US, when they raised it. Recorded as an annotation
  // and nothing more: a supplier who cannot ship to the US still sells at origin,
  // which is exactly how the distributor clients buy, so this must never read as
  // a reason to drop them. Best-effort, and only written when the verdict is new
  // or has changed, so an operator sees the latest thing the supplier said.
  if (bodyExtraction.shipsToUs && leadId) {
    try {
      const { data: geoRow } = await admin.from("leads_in_flight").select("payload").eq("id", leadId).maybeSingle();
      const geoPayload = (geoRow?.payload ?? {}) as Record<string, any>;
      if (shipsToUsVerdict(geoPayload) !== bodyExtraction.shipsToUs) {
        const annotation: ShipsToUsAnnotation = {
          verdict: bodyExtraction.shipsToUs,
          said_at: msg.received_at ?? new Date().toISOString(),
          source: "supplier_reply",
          evidence: bodyExtraction.shipsToUsEvidence,
        };
        await admin
          .from("leads_in_flight")
          .update({ payload: { ...geoPayload, ships_to_us: annotation } })
          .eq("id", leadId);
      }
    } catch {
      // An annotation is advisory; losing it must not cost us the reply draft.
    }
  }

  // 5. Compose the reply. Pull the full thread from Tenkara for context so the
  // reply answers what they actually asked and doesn't repeat earlier messages.
  let orgName = "the client";
  if (ref.org_id) {
    const { data: o } = await admin.from("orgs").select("name").eq("id", ref.org_id).maybeSingle();
    orgName = o?.name ?? "the client";
  }
  const mode = (refMeta.outreach_mode === "ghost" ? "ghost" : "active") as "active" | "ghost";
  let threadContext: string | null = null;
  try {
    const thread = await getTenkaraConversationMessages(msg.conversation_id);
    if (thread.length) {
      threadContext = thread
        .map((m) => `[${m.sent_at ?? "?"}] ${m.from_name || m.from_email || "?"}: ${(m.body_text ?? "").trim().slice(0, 1200)}`)
        .join("\n\n")
        .slice(0, 8000);
    }
  } catch {
    // no context — proceed with just the inbound message
  }
  // Phased outreach: other materials for this supplier held back from the first
  // email (payload.phased_hold). If the supplier is engaged, this reply
  // introduces them and we release the hold; otherwise they stay held.
  let heldLeads: { id: string; material_id: string | null; material_name: string | null; payload: any }[] = [];
  if (ref.supplier_id) {
    const { data: hl } = await admin
      .from("leads_in_flight")
      .select("id, material_id, material_name, payload")
      .eq("org_id", ref.org_id)
      .eq("supplier_id", ref.supplier_id)
      .eq("status", "active");
    heldLeads = ((hl ?? []) as any[]).filter((l) => (l.payload ?? {}).phased_hold);
  }
  const heldMaterialNames = heldLeads.map((l) => l.material_name).filter((n): n is string => !!n && !!n.trim());

  // Backlog #14: from everything captured for this supplier+material so far
  // (including the quotes just staged above from this very reply), work out which
  // approval-required quote fields are still missing, so the reply keeps inquiring
  // for the next couple until the quote is complete. Best-effort and gated by
  // COMPLETENESS_FOLLOWUP_ENABLED; a miss just means no completeness ask this turn.
  let missingApprovalFields: MissingApprovalField[] = [];
  if (completenessFollowupEnabled() && ref.supplier_id) {
    try {
      if (!ref.org_id || !ref.material_id) throw new Error("completeness requires exact org and material");
      const { data: capturedRows, error: quoteError } = await admin
        .from("staged_quotes")
        .select(
          "price, case_size, unit_of_measurement, case_type, case_dimensions, dim_source, raw_extract, lead_time_days, lead_time_text, moq_quantity, moq_unit, payment_terms, status"
        )
        .eq("org_id", ref.org_id)
        .eq("supplier_id", ref.supplier_id)
        .eq("material_id", ref.material_id)
        .not("status", "eq", "dismissed");
      if (quoteError) throw quoteError;
      const { data: supplierProfile, error: profileError } = await admin
        .from("supplier_profiles")
        .select("poc_email, poc_phone, poc_name, shipping_address, shipping_terms, shipping_email, billing_email, billing_poc_name, payment_upfront_pct, payment_net_days, payment_completion, payment_credit_line")
        .eq("org_id", ref.org_id)
        .eq("supplier_id", ref.supplier_id)
        .maybeSingle();
      if (profileError) throw profileError;
      missingApprovalFields = computeMissingApprovalFields((capturedRows ?? []) as any, supplierProfile as any);
    } catch {
      missingApprovalFields = [];
    }
  }

  if (currentTurns >= MAX_REPLY_TURNS && !bodyExtraction.declined) {
    await admin
      .from("draft_references")
      .update({ metadata: { ...refMeta, flow_status: "stale", reply_detected: replyDetected, reply_turns: currentTurns, note: `max ${MAX_REPLY_TURNS} turns reached` } })
      .eq("id", ref.id);
    return { status: 200, body: { reply_detected: true, drafted: false, reason: "max_reply_turns" } };
  }

  // The grade the client specified for this material, so the reply holds a
  // dealbreaker spec instead of accepting whatever variant the supplier offers.
  // Best-effort: a resolve failure just leaves the reply grade-blind as before.
  let materialGrade: { all: string; required: string | null } | null = null;
  if (ref.material_id) {
    try {
      materialGrade = (await resolveMaterialGradeSpecs([ref.material_id])).get(ref.material_id) ?? null;
    } catch {
      materialGrade = null;
    }
  }

  const reply = await composeReply({
    mode,
    clientOrgName: orgName,
    ghostBrand: refMeta.ghost_brand ?? undefined,
    supplierName: leadRow?.supplier_name ?? null,
    supplierContactName: (leadRow?.payload as any)?.supplier_contact_name ?? from.name,
    materialName: leadRow?.material_name ?? null,
    materialGrade,
    originalSubject: ref.subject,
    theirSubject: msg.subject ?? null,
    theirPreview: msg.body_text ?? null,
    receivedAttachments,
    threadContext,
    heldMaterialNames,
    missingApprovalFields: bodyExtraction.declined ? [] : missingApprovalFields,
    shipToRegion: (await getClientShipTo(admin, ref.org_id))?.region ?? null,
    shipsToUs: bodyExtraction.shipsToUs ?? shipsToUsVerdict(leadRow?.payload as any),
  });

  // Introduce held materials only when the supplier engaged and did not hard-decline.
  const introduceHeld = !bodyExtraction.declined && reply.engaged && heldLeads.length > 0;
  const introducedMaterialIds = introduceHeld ? (heldLeads.map((l) => l.material_id).filter(Boolean) as string[]) : [];
  const replyMaterialIds = Array.from(new Set([ref.material_id, ...introducedMaterialIds].filter(Boolean))) as string[];

  // 6. Resolve Agent 08 for attribution (best-effort).
  const { data: agent08 } = await admin
    .from("agents")
    .select("id")
    .eq("slug", "agent-08-email-scanner")
    .maybeSingle();

  // 7. Stage the reply as a Tenkara draft in the same conversation.
  const staged = await stageDraft({
    admin,
    agentId: agent08?.id ?? null,
    runId: null,
    orgId: ref.org_id,
    supplierId: ref.supplier_id,
    materialId: ref.material_id,
    conversationId: msg.conversation_id,
    to: from,
    subject: reply.subject,
    body: reply.body,
    assignedOperator: ref.assigned_operator,
    metadata: {
      outreach_mode: mode,
      ghost_brand: refMeta.ghost_brand ?? null,
      supplier_name: leadRow?.supplier_name ?? from.name ?? null,
      material_name: leadRow?.material_name ?? null,
      material_ids: replyMaterialIds,
      introduced_material_ids: introducedMaterialIds,
      required_grade: materialGrade?.required ?? null,
      draft_kind: introduceHeld ? "inbound_reply_with_followup" : "inbound_reply",
      in_reply_to_draft_ref: ref.id,
      in_reply_to_message_id: msg.message_id,
      reply_to_conversation_id: msg.conversation_id,
      lead_id: leadId ?? null,
      reply_turns: bodyExtraction.declined ? currentTurns : currentTurns + 1,
    },
  });
  if (!staged.ok) return { status: 502, body: { error: `stage_reply_failed: ${staged.error}` } };
  if (staged.blocked || !staged.draftId) {
    return { status: 200, body: { drafted: false, blocked: true, draft_ref_id: staged.draftRefId } };
  }

  // Release the introduced materials: they're now part of this live conversation.
  // Clear the hold and promote them. Fires once — the hold is gone, so a later
  // reply won't re-introduce them.
  if (introduceHeld) {
    for (const hl of heldLeads) {
      const { phased_hold, ...restPayload } = (hl.payload ?? {}) as any;
      await admin
        .from("leads_in_flight")
        .update({
          stage: "ready_for_outreach",
          payload: {
            ...restPayload,
            outreach: {
              ...(restPayload.outreach ?? {}),
              email_client: "rod_app",
              conversation_id: msg.conversation_id,
              introduced_via: "reply_followup",
              introduced_at: new Date().toISOString(),
              introduced_in_draft_ref: staged.draftRefId ?? null,
            },
          },
        })
        .eq("id", hl.id);
    }
  }

  // 8. Point the originating draft at the reply we just staged.
  await admin
    .from("draft_references")
    .update({
      metadata: {
        ...refMeta,
        flow_status: bodyExtraction.declined ? "closed_declined" : flowAt("responded"),
        reply_turns: bodyExtraction.declined ? currentTurns : currentTurns + 1,
        reply_detected: replyDetected,
        reply_draft: {
          draft_ref_id: staged.draftRefId,
          staged_at: new Date().toISOString(),
          conversation_id: staged.conversationId,
          in_reply_to_message_id: msg.message_id,
        },
      },
    })
    .eq("id", ref.id);

  return { status: 200, body: { drafted: true, draft_ref_id: staged.draftRefId, draft_id: staged.draftId, quotes_staged: quotesStaged, introduced_materials: introducedMaterialIds.length, domain_match_fallback: domainMatchFallback || undefined, exact_address_match: exactAddressMatch || undefined, alias_address_match: aliasAddressMatch || undefined } };
}

async function recordUnmatchedInbound(
  admin: Admin,
  msg: InboundMessage,
  inboundOrg: { orgId: string; accountKey: string } | null
): Promise<InboundResult> {
  const from = parseFrom(msg.from);
  if (isBounce(from.address, msg.subject ?? null)) {
    return { status: 200, body: { ignored: true, reason: "unmatched_bounce" } };
  }
  const processingToken = randomUUID();
  const eventKey = `${msg.conversation_id}:${msg.message_id}`;
  const { data: insertedEvent, error: insertEventError } = await admin
    .from("unmatched_inbound_events")
    .insert({
      message_id: msg.message_id,
      conversation_id: msg.conversation_id,
      org_id: inboundOrg?.orgId ?? null,
      account_id: msg.email_account_id ?? null,
      recipient_email: msg.to_email ?? null,
      sender_email: from.address.toLowerCase(),
      processing_token: inboundOrg ? processingToken : null,
      claimed_at: inboundOrg ? new Date().toISOString() : null,
    })
    .select("id, case_id, draft_reference_id")
    .maybeSingle();

  if (!inboundOrg) {
    if (insertEventError && insertEventError.code !== "23505") {
      return { status: 503, body: { error: "unmatched_dead_letter_failed", detail: insertEventError.message } };
    }
    const slackSafe = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@/g, "＠");
    await postAgentAlert([
      ":warning: *Unmatched inbound needs client assignment*",
      `from: ${slackSafe(from.address)}`,
      `subject: ${slackSafe(msg.subject ?? "(none)")}`,
      `conversation: ${slackSafe(msg.conversation_id)}`,
      "The event was recorded, but its receiving inbox is not mapped to a Control Room client.",
    ].join("\n"));
    return { status: 200, body: { recorded_unmatched: true, needs_org_assignment: true } };
  }

  let event = insertedEvent;
  if (insertEventError) {
    if (insertEventError.code !== "23505") {
      return { status: 503, body: { error: "unmatched_event_claim_failed", detail: insertEventError.message } };
    }
    const { data: existing, error: readError } = await admin
      .from("unmatched_inbound_events")
      .select("id, case_id, draft_reference_id, claimed_at")
      .eq("conversation_id", msg.conversation_id)
      .eq("message_id", msg.message_id)
      .maybeSingle();
    if (readError || !existing) {
      return { status: 503, body: { error: "unmatched_event_read_failed", detail: readError?.message } };
    }
    if (existing.case_id && existing.draft_reference_id) {
      return { status: 200, body: { deduped: true, reason: "recorded_unmatched", case_id: existing.case_id, draft_ref_id: existing.draft_reference_id } };
    }
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    const { data: claimed, error: leaseError } = await admin
      .from("unmatched_inbound_events")
      .update({ processing_token: processingToken, claimed_at: new Date().toISOString(), org_id: inboundOrg.orgId })
      .eq("id", existing.id)
      .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
      .select("id, case_id, draft_reference_id")
      .maybeSingle();
    if (leaseError) return { status: 503, body: { error: "unmatched_event_lease_failed", detail: leaseError.message } };
    if (!claimed) return { status: 503, body: { error: "unmatched_event_processing" } };
    event = claimed;
  }
  if (!event) return { status: 503, body: { error: "unmatched_event_missing" } };

  const senderLabel = from.name ? `${from.name} <${from.address}>` : from.address;
  let caseId: string | null = event.case_id ?? null;
  if (!caseId) {
    const { data: existingCase, error: existingError } = await admin
      .from("cases")
      .select("id")
      .eq("org_id", inboundOrg.orgId)
      .eq("type", "unmatched_inbound")
      .eq("metadata->>message_id", msg.message_id)
      .maybeSingle();
    if (existingError) return { status: 503, body: { error: "unmatched_case_read_failed", detail: existingError.message } };
    caseId = existingCase?.id ?? null;
    if (!caseId) {
      const { data: insertedCase, error: insertError } = await admin
        .from("cases")
        .insert({
          org_id: inboundOrg.orgId,
          type: "unmatched_inbound",
          status: "open",
          originating_thread_id: msg.conversation_id,
          recommended_action: `Review the clarification draft for inbound from ${senderLabel}, then link the conversation to the correct supplier and material.`,
          metadata: {
            source: "tenkara-inbound-unmatched",
            message_id: msg.message_id,
            conversation_id: msg.conversation_id,
            sender_name: from.name,
            sender_email: from.address,
            subject: msg.subject ?? null,
          },
        })
        .select("id")
        .maybeSingle();
      if (insertError || !insertedCase?.id) {
        return { status: 503, body: { error: "unmatched_case_create_failed", detail: insertError?.message } };
      }
      caseId = insertedCase.id;
    }
    const { error: eventCaseError } = await admin
      .from("unmatched_inbound_events")
      .update({ case_id: caseId })
      .eq("id", event.id);
    if (eventCaseError) return { status: 503, body: { error: "unmatched_event_case_update_failed", detail: eventCaseError.message } };
  }

  let draftRefId: string | null = event.draft_reference_id ?? null;
  if (!draftRefId) {
    const { data: existingDraft, error: draftReadError } = await admin
      .from("draft_references")
      .select("id")
      .eq("email_client", "rod_app")
      .eq("metadata->>unmatched_event_key", eventKey)
      .maybeSingle();
    if (draftReadError) return { status: 503, body: { error: "unmatched_draft_read_failed", detail: draftReadError.message } };
    draftRefId = existingDraft?.id ?? null;
    if (!draftRefId) {
      const { data: agent08, error: agentError } = await admin
        .from("agents")
        .select("id")
        .eq("slug", "agent-08-email-scanner")
        .maybeSingle();
      if (agentError) return { status: 503, body: { error: "unmatched_agent_read_failed", detail: agentError.message } };

      const subject = msg.subject?.trim() ? `Re: ${msg.subject.replace(/^re:\s*/i, "")}` : "Re: Your message";
      const body = [
        "Thanks for reaching out.",
        "",
        "We could not confidently match this message to an active sourcing inquiry. Could you confirm the company you represent and the material or product this message concerns?",
        "",
        "Once confirmed, our sourcing team will connect your response to the correct request.",
      ].join("\n");
      const staged = await stageDraft({
        admin,
        agentId: agent08?.id ?? null,
        runId: null,
        orgId: inboundOrg.orgId,
        to: { name: from.name, address: from.address },
        subject,
        body,
        conversationId: msg.conversation_id,
        metadata: {
          draft_kind: "unmatched_inbound_clarification",
          unmatched_event_key: eventKey,
          in_reply_to_message_id: msg.message_id,
          triage_case_id: caseId,
        },
      });
      if (!staged.ok || !staged.draftRefId) {
        return { status: 503, body: { error: "unmatched_draft_create_failed", detail: staged.error } };
      }
      draftRefId = staged.draftRefId;
    }
    const { error: eventDraftError } = await admin
      .from("unmatched_inbound_events")
      .update({ draft_reference_id: draftRefId })
      .eq("id", event.id);
    if (eventDraftError) return { status: 503, body: { error: "unmatched_event_draft_update_failed", detail: eventDraftError.message } };
  }

  const slackSafe = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@/g, "＠");
  await postAgentAlert([
    ":envelope_with_arrow: *Unmatched inbound recorded for triage*",
    `from: ${slackSafe(senderLabel)}`,
    `subject: ${slackSafe(msg.subject ?? "(none)")}`,
    `conversation: ${slackSafe(msg.conversation_id)}`,
    "A triage case and review-only clarification draft were created.",
  ].join("\n"));

  return { status: 200, body: { recorded_unmatched: true, org_id: inboundOrg.orgId, case_id: caseId, draft_ref_id: draftRefId } };
}
