import type { SupabaseClient } from "@supabase/supabase-js";

// An operator throwing a draft away is a decision, and it did not survive.
//
// Nothing consulted the discarded pile before writing a new draft, so the next
// sweep composed the same email to the same supplier again. Agent 02 only had a
// time debounce, which delays a redraft rather than preventing it, and the
// follow-up sweeps had nothing at all.
//
// This is the one place that answers "did an operator already reject this".
// Every draft goes through stageDraft, so the check lives there; Agent 02 writes
// its pointer row directly and calls this itself.
//
// Three deliberate exceptions, because each one is a NEW decision rather than a
// repeat of the rejected one:
//
//  - A draft we discarded ourselves. Retiring a bounced or replaced address
//    discards its drafts precisely so a fresh one goes to the new address.
//  - A different recipient. Rejecting an email to the wrong person says nothing
//    about the right one.
//  - A reply to something the supplier just sent us. If they write again, ops
//    needs a draft; the inbound path already dedupes per inbound message.

/** Discards our own code performed. These never suppress anything. */
const SYSTEM_DISCARD_REASONS = new Set([
  "contact_email_replaced",
  "contact_email_removed",
  "lead_dropped",
  "superseded_by_newer_draft",
]);

/** Kinds we compose on our own initiative, so a rejection means "stop". */
const OPERATOR_SUPPRESSIBLE_KINDS = new Set([
  "cold_outbound",
  "no_reply_followup",
  "stalled_followup",
  "call_followup",
  "unmatched_inbound_clarification",
]);

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/**
 * A discard suppresses the address, and we are never told why. That is fine when
 * the supplier was rejected and wrong when only the contact was: the supplier
 * keeps its lead and profile, but nothing writes to it again, and the contact
 * re-hunt only picks up leads holding NO address, so a supplier whose one
 * address was discarded can never re-enter it. 149 sat in exactly that state.
 *
 * The email app is not ours and its discard event carries no reason, so we ask
 * afterwards: every operator discard raises an escalation on the client's Email
 * Thread Tracker. Answering it acts. Wrong contact -> add the working address,
 * which requeues the lead (the suppression is address-level, so the new one is
 * free to send). Not a fit -> resolve, and the supplier stays out.
 *
 * Only operator discards. Our own discards (a retired address, a dropped lead)
 * already know why they happened and must not ask anyone.
 */
export async function raiseDiscardReviewCase(
  admin: SupabaseClient<any, any, any>,
  ref: {
    id: string;
    org_id: string | null;
    supplier_id: string | null;
    material_id?: string | null;
    assigned_operator?: string | null;
    draft_id?: string | null;
    thread_id?: string | null;
    metadata: Record<string, any> | null;
  }
): Promise<{ raised: boolean; reason?: string }> {
  const meta = (ref.metadata ?? {}) as Record<string, any>;
  const kind = norm(meta.draft_kind);
  if (!ref.org_id) return { raised: false, reason: "no_org" };
  if (!OPERATOR_SUPPRESSIBLE_KINDS.has(kind)) return { raised: false, reason: "kind_not_suppressible" };
  if (SYSTEM_DISCARD_REASONS.has(String(meta.discarded_reason ?? ""))) return { raised: false, reason: "system_discard" };

  const address = String(meta.supplier_contact_email ?? "").trim();
  if (!address) return { raised: false, reason: "no_address" };

  // One question per supplier and address, not per draft: several materials to
  // one supplier discard as several drafts and it is a single decision.
  let dupe = admin
    .from("cases")
    .select("id")
    .eq("org_id", ref.org_id)
    .eq("type", "draft_discarded")
    .eq("status", "open")
    .eq("metadata->>supplier_contact_email", address.toLowerCase());
  dupe = ref.supplier_id ? dupe.eq("supplier_id", ref.supplier_id) : dupe.is("supplier_id", null);
  const { data: existing } = await dupe.limit(1).maybeSingle();
  if (existing) return { raised: false, reason: "already_open" };

  const supplierLabel = (meta.supplier_name as string | undefined) ?? "this supplier";
  const { error } = await admin.from("cases").insert({
    org_id: ref.org_id,
    type: "draft_discarded",
    status: "open",
    supplier_id: ref.supplier_id,
    material_id: ref.material_id ?? null,
    assigned_operator: ref.assigned_operator ?? null,
    recommended_action:
      `The email to ${supplierLabel} (${address}) was discarded in the email app. Why? ` +
      `If the contact was wrong, enter a working address and outreach restarts. ` +
      `If the supplier is not a fit, resolve with a note and we leave them out.`,
    metadata: {
      source: "tenkara-draft-discarded",
      draft_reference_id: ref.id,
      draft_id: ref.draft_id ?? null,
      thread_id: ref.thread_id ?? null,
      lead_id: (meta.lead_id as string | undefined) ?? null,
      supplier_name: (meta.supplier_name as string | undefined) ?? null,
      material_name: (meta.material_name as string | undefined) ?? null,
      supplier_contact_email: address.toLowerCase(),
      draft_kind: kind,
      discarded_at: meta.tenkara_webhook?.occurred_at ?? new Date().toISOString(),
      discarded_by: meta.tenkara_webhook?.operator ?? null,
    },
  });
  if (error) return { raised: false, reason: error.message };
  return { raised: true };
}

export interface SuppressionQuery {
  orgId: string | null;
  supplierId?: string | null;
  threadId?: string | null;
  kind: string | null | undefined;
  toAddress: string | null | undefined;
}

export interface SuppressionVerdict {
  suppressed: boolean;
  reason?: string;
  discardedAt?: string | null;
  discardedDraftRefId?: string;
}

/**
 * True when an operator already discarded this same kind of draft, to this same
 * supplier and address, and nothing has changed since.
 */
export async function isDraftSuppressed(
  admin: SupabaseClient<any, any, any>,
  q: SuppressionQuery
): Promise<SuppressionVerdict> {
  const kind = norm(q.kind);
  const to = norm(q.toAddress);
  if (!q.orgId || !kind || !to) return { suppressed: false };
  if (!OPERATOR_SUPPRESSIBLE_KINDS.has(kind)) return { suppressed: false };
  if (!q.supplierId && !q.threadId) return { suppressed: false };

  let query = admin
    .from("draft_references")
    .select("id, reviewed_at, created_at, metadata")
    .eq("org_id", q.orgId)
    .eq("status", "discarded")
    .eq("metadata->>draft_kind", kind)
    // Address matched in JS, not in the query: drafts were written with whatever
    // capitalisation discovery found ("Ro@smirks.com"), so an equality filter on
    // a lowercased address silently matched nothing and suppressed nothing.
    .order("created_at", { ascending: false })
    .limit(25);
  // Prefer the supplier: the same company can span several threads. Fall back to
  // the thread for leads discovery handed over without a supplier id.
  query = q.supplierId ? query.eq("supplier_id", q.supplierId) : query.eq("thread_id", q.threadId as string);

  const { data, error } = await query;
  if (error || !data?.length) return { suppressed: false };

  for (const row of data as any[]) {
    const meta = (row.metadata ?? {}) as Record<string, any>;
    if (norm(meta.supplier_contact_email) !== to) continue;
    if (SYSTEM_DISCARD_REASONS.has(String(meta.discarded_reason ?? ""))) continue;
    return {
      suppressed: true,
      reason: meta.tenkara_webhook?.event === "draft.discarded" ? "discarded_in_email_app" : "discarded_by_operator",
      discardedAt: row.reviewed_at ?? row.created_at ?? null,
      discardedDraftRefId: row.id,
    };
  }
  return { suppressed: false };
}
