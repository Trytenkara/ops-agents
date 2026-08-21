import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteTenkaraDrafts } from "@/lib/tenkara";
import { selectAllPaged } from "@/lib/supabase-paging";

// One home for "the address we mail this supplier on just changed".
//
// Five separate surfaces write a supplier contact email (inline lead edit, the
// bounced-address case resolver, the CSV import, the marketplace outreach
// approval, and Agent 22). Each of them used to write the new address and stop
// there, which left three things behind every time:
//
//   1. the replaced address still sitting in additional_contacts, so it was CC'd
//      on the next email even though an operator had just corrected it;
//   2. a draft already staged to the replaced address, still live in the inbox
//      for someone to send;
//   3. `payload.operator_email_outreach`, the one-shot stamp Agent 22 sets, so a
//      SECOND correction on the same lead was invisible and never drafted.
//
// Retiring an address is therefore a single operation, not a field write. Every
// writer must go through `applyContactChange`, and every recipient chooser must
// ask `isRetiredContact` before putting an address in To or CC.

export type RetireReason = "replaced" | "deleted" | "bounced";

export interface RetiredContact {
  email: string;
  at: string;
  reason: RetireReason;
  by?: string | null;
}

const MAX_RETIRED = 25;

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function retiredEmails(payload: any): Set<string> {
  const list = Array.isArray(payload?.retired_contacts) ? payload.retired_contacts : [];
  return new Set(list.map((r: any) => norm(r?.email)).filter(Boolean));
}

// The positive form of the rule: an address is mailable unless it is on the
// lead's retired list. A blocklist of bad patterns would never be complete;
// this asks the record what an operator (or a bounce) already ruled out.
export function isRetiredContact(payload: any, email: string | null | undefined): boolean {
  const e = norm(email);
  return !!e && retiredEmails(payload).has(e);
}

// Pure. Records the address as retired and removes EVERY copy of it from the
// payload, because any copy left behind is a live send target: additional_contacts
// is CC'd on first contact, and email_check is read as authorisation by outreach.
export function retireInPayload(
  payload: Record<string, any>,
  email: string | null | undefined,
  reason: RetireReason,
  by?: string | null
): Record<string, any> {
  const target = norm(email);
  if (!target) return payload;

  const next: Record<string, any> = { ...payload };
  const enrichment = next.enrichment ? { ...next.enrichment } : undefined;

  if (norm(next.supplier_contact_email) === target) next.supplier_contact_email = null;
  if (norm(next.aggregator_contact_email) === target) next.aggregator_contact_email = null;
  if (Array.isArray(next.additional_contacts)) {
    next.additional_contacts = next.additional_contacts.filter((c: any) => norm(c?.email) !== target);
  }
  if (enrichment) {
    if (norm(enrichment.aggregator_contact_email) === target) enrichment.aggregator_contact_email = null;
    if (enrichment.contact && norm(enrichment.contact.email) === target) {
      enrichment.contact = { ...enrichment.contact, email: null };
    }
    // email_check describes ONE address. Left behind, its domain_matches_website
    // verdict authorises outreach to an address nobody checked.
    if (enrichment.email_check && norm(enrichment.email_check.email) === target) delete enrichment.email_check;
    next.enrichment = enrichment;
  }

  const existing: RetiredContact[] = Array.isArray(next.retired_contacts) ? next.retired_contacts : [];
  next.retired_contacts = [
    ...existing.filter((r) => norm(r?.email) !== target),
    { email: target, at: new Date().toISOString(), reason, by: by ?? null },
  ].slice(-MAX_RETIRED);

  return next;
}

export interface ContactChangeResult {
  payload: Record<string, any>;
  draftsDiscarded: number;
  /** True when a sent or linked thread already exists on the old address, so the
   *  lead must NOT be requeued for a fresh cold email. */
  hasLiveThread: boolean;
  warning?: string;
}

/**
 * Retire `previous` and hand back the payload to write, having cleaned up
 * everything the old address left running.
 *
 * Callers own the row update itself (each surface writes different neighbouring
 * fields), so this returns the payload rather than saving it.
 */
export async function applyContactChange(
  admin: SupabaseClient<any, any, any>,
  args: {
    lead: { id: string; org_id: string | null; supplier_id?: string | null };
    payload: Record<string, any>;
    previous: string | null | undefined;
    next: string | null | undefined;
    reason?: RetireReason;
    actorUserId?: string | null;
  }
): Promise<ContactChangeResult> {
  const previous = norm(args.previous);
  const next = norm(args.next);
  let payload = { ...args.payload };
  let draftsDiscarded = 0;
  let hasLiveThread = false;
  let warning: string | undefined;

  const changed = !!previous && previous !== next;

  if (changed) {
    payload = retireInPayload(payload, previous, args.reason ?? (next ? "replaced" : "deleted"), args.actorUserId);
    // Put the new address back: retireInPayload nulls supplier_contact_email when
    // it matches, and on a replacement the caller has already chosen the new one.
    if (next) payload.supplier_contact_email = next;
  }

  // Agent 22's stamp is a one-shot latch. A corrected address is a NEW address to
  // reach out on, so clear it or the second correction is never acted on.
  if (changed && next) delete payload.operator_email_outreach;

  if (changed && args.lead.org_id) {
    // PERS-06: the address being corrected is matched in JS across every live
    // draft for the org, so a 2,000-row window meant a stale address on draft
    // 2,001 was simply never corrected.
    const refs = await selectAllPaged<any>((from, to) =>
      admin
        .from("draft_references")
        .select("id, draft_id, thread_id, status, metadata, email_client")
        .eq("org_id", args.lead.org_id!)
        .in("status", ["staged", "reviewed", "blocked", "sent", "linked"])
        .order("id")
        .range(from, to)
    );

    for (const ref of refs) {
      const to = norm(ref.metadata?.supplier_contact_email);
      const cc = Array.isArray(ref.metadata?.cc_contacts) ? ref.metadata.cc_contacts.map(norm) : [];
      if (to !== previous && !cc.includes(previous)) continue;

      // A conversation the supplier can already see is history, not a draft. It
      // stays; Agent 22 CCs the corrected address onto it instead of cold
      // emailing the same company twice.
      if (ref.status === "sent" || ref.status === "linked") {
        hasLiveThread = true;
        continue;
      }
      // Only ours are deletable, and only in Tenkara.
      if (ref.email_client !== "rod_app" || (!ref.draft_id && !ref.thread_id)) continue;

      const del = await deleteTenkaraDrafts({ draftId: ref.draft_id, conversationId: ref.thread_id });
      if (del.ok) {
        await admin
          .from("draft_references")
          .update({
            status: "discarded",
            metadata: { ...(ref.metadata ?? {}), discarded_reason: "contact_email_replaced", retired_email: previous },
          })
          .eq("id", ref.id);
        draftsDiscarded++;
      } else {
        warning = `the draft to ${previous} could not be removed (${del.error ?? "unknown"}) — delete it in the Inbox`;
      }
    }

    // The alias row reserves an address org-wide. Left behind, it silently blocks
    // that address on every future thread.
    await admin.from("supplier_email_aliases").delete().eq("org_id", args.lead.org_id).eq("email", previous);
  }

  return { payload, draftsDiscarded, hasLiveThread, warning };
}
