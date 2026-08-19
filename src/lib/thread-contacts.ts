import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenkaraMessage } from "@/lib/tenkara";
import { isRetiredContact } from "@/lib/contact-change";
import { isAggregatorEmail } from "@/agents-runtime/agents/data-enrichment/enrich";

// Addresses an operator adds inside the email app were invisible here.
//
// Ops routinely fix a thread by hand: they CC the person who actually answers
// quotes, or the supplier replies from a different mailbox than the one we
// wrote to. All of that lives in Tenkara and nothing read it back, so the next
// nudge, the next sourcing inquiry and every CSV export still carried only the
// address discovery had guessed. This harvests both directions of the thread
// (who wrote to us, and who WE were sent to, which is where a hand-added CC
// shows up) and files anything new onto the lead as an additional contact.
//
// It only ever ADDS. Nothing here promotes an address to the primary contact:
// choosing who a client is represented by stays an operator's decision.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Machine mailboxes that are never a person to reach.
const NEVER_A_CONTACT = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?|notifications?|automated?|support-?bot)@/i;

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

function splitRecipients(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((part) => {
      const angled = part.match(/<([^>]+)>/);
      return norm(angled ? angled[1] : part);
    })
    .filter((e) => EMAIL_RE.test(e));
}

/** Every address on the thread that is neither ours nor a machine. */
export function threadParticipants(messages: TenkaraMessage[]): { email: string; name: string | null }[] {
  const ours = new Set<string>();
  for (const m of messages) {
    if (m.is_outbound) {
      const from = norm(m.from_email);
      if (from) ours.add(from);
    }
  }

  const found = new Map<string, string | null>();
  const add = (email: string, name: string | null) => {
    if (!EMAIL_RE.test(email) || ours.has(email) || NEVER_A_CONTACT.test(email)) return;
    // A marketplace's own mailbox reaches the platform, not the supplier.
    if (isAggregatorEmail(email)) return;
    if (!found.has(email) || (!found.get(email) && name)) found.set(email, name);
  };

  for (const m of messages) {
    if (m.is_outbound) {
      // Who we were sent to. An operator adding a colleague in the email app
      // appears here and nowhere else.
      for (const r of splitRecipients(m.to)) add(r, null);
    } else {
      add(norm(m.from_email), m.from_name ?? null);
      for (const r of splitRecipients(m.to)) add(r, null);
    }
  }
  return Array.from(found.entries()).map(([email, name]) => ({ email, name }));
}

/**
 * File any address seen on the thread but missing from the lead onto
 * `payload.additional_contacts`, so the next email reaches the people who are
 * actually in the conversation. Returns how many addresses were new.
 */
export async function harvestThreadContacts(
  admin: SupabaseClient<any, any, any>,
  args: { orgId: string | null; threadId: string; messages: TenkaraMessage[] }
): Promise<number> {
  if (!args.orgId || !args.threadId || !args.messages.length) return 0;
  const participants = threadParticipants(args.messages);
  if (!participants.length) return 0;

  const { data: refs } = await admin
    .from("draft_references")
    .select("metadata")
    .eq("org_id", args.orgId)
    .eq("thread_id", args.threadId)
    .limit(50);

  const leadIds = new Set<string>();
  for (const ref of (refs ?? []) as any[]) {
    for (const id of Array.isArray(ref.metadata?.lead_ids) ? ref.metadata.lead_ids : []) {
      if (typeof id === "string") leadIds.add(id);
    }
  }
  if (!leadIds.size) return 0;

  const { data: leads } = await admin
    .from("leads_in_flight")
    .select("id, payload")
    .in("id", Array.from(leadIds))
    .eq("status", "active");

  let added = 0;
  for (const lead of (leads ?? []) as any[]) {
    const payload = (lead.payload ?? {}) as Record<string, any>;
    const known = new Set<string>([
      norm(payload.supplier_contact_email),
      norm(payload.aggregator_contact_email),
      ...(Array.isArray(payload.additional_contacts) ? payload.additional_contacts.map((c: any) => norm(c?.email)) : []),
    ]);
    const fresh = participants.filter((p) => !known.has(p.email) && !isRetiredContact(payload, p.email));
    if (!fresh.length) continue;

    const next = {
      ...payload,
      additional_contacts: [
        ...(Array.isArray(payload.additional_contacts) ? payload.additional_contacts : []),
        ...fresh.map((p) => ({ email: p.email, name: p.name, source: "email_app", seen_at: new Date().toISOString() })),
      ],
    };
    await admin.from("leads_in_flight").update({ payload: next }).eq("id", lead.id);
    added += fresh.length;
  }
  return added;
}
