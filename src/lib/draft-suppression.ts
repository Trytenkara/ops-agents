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

// Tenkara is where a client actually denies a supplier, and nothing on our side
// read that verdict, so the fleet kept sourcing and drafting to suppliers the
// client had already rejected. Cached per process: the set changes rarely and
// this is consulted on every draft.
const DENIED_TTL_MS = 5 * 60 * 1000;
let deniedCache: { at: number; ids: Set<string> } | null = null;

async function deniedSupplierIds(): Promise<Set<string>> {
  const now = nowMs();
  if (deniedCache && now - deniedCache.at < DENIED_TTL_MS) return deniedCache.ids;
  try {
    const { tenkaraQuery } = await import("@/lib/tenkara-readonly");
    const rows = (await tenkaraQuery(`select id from suppliers where approval = 'denied'`)) as { id: string }[];
    deniedCache = { at: now, ids: new Set(rows.map((r) => r.id)) };
  } catch (e) {
    // Fail open. A read-only database we cannot reach must never stop ops
    // getting a draft; the worst case is the status quo before this existed.
    console.warn(`[draft-suppression] denied-supplier lookup failed: ${(e as any)?.message ?? e}`);
    deniedCache = { at: now, ids: deniedCache?.ids ?? new Set() };
  }
  return deniedCache.ids;
}

function nowMs(): number {
  return new Date().getTime();
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
  // A denial in the email app outranks everything else, including the kind of
  // draft: if the client rejected the supplier, we do not write to them at all,
  // not even to answer a reply.
  if (q.supplierId && (await deniedSupplierIds()).has(q.supplierId)) {
    return { suppressed: true, reason: "supplier_denied_in_email_app" };
  }

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
