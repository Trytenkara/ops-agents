import type { SupabaseClient } from "@supabase/supabase-js";
import { buildCallWindow, type CallWindow } from "@/lib/call-window";

// The brief an operator needs to pick up the phone: who to call, on what number,
// when they are awake, what we already sent them, and what to actually ask for.
//
// Everything here is assembled from rows we already hold (the draft thread, the
// lead payload, the supplier profile). Nothing is generated or inferred, because
// an operator reading "you asked about X on the 4th" is going to say exactly that
// out loud to the supplier, and a plausible-but-wrong detail becomes a lie told
// on a live call.

export interface CallBriefContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  // Where the number came from, so a bad one can be traced back and corrected.
  phoneSource: "lead_payload" | "supplier_profile" | "tenkara_supplier" | null;
}

export interface CallBrief {
  contact: CallBriefContact;
  phoneStatus: "known" | "missing";
  supplierName: string | null;
  supplierWebsite: string | null;
  country: string | null;
  window: CallWindow;
  // What has happened on this conversation so far, newest last.
  context: string[];
  // What the call is for. First line is the reason, the rest are the asks.
  purpose: string;
  asks: string[];
  materialNames: string[];
  requiredGrade: string | null;
  threadId: string | null;
  leadId: string | null;
  // Which call in the cadence this is (1-based), shown to the operator as "Call N".
  callStage: number;
  builtAt: string;
}

// Outcomes an operator can log against a calling escalation. Terminal ones
// resolve the case; the rest leave it open so the next attempt is still queued,
// because a supplier who did not pick up has not been dealt with.
export const CALL_OUTCOMES = {
  reached: { label: "Reached them", terminal: true },
  voicemail: { label: "Left a voicemail", terminal: false },
  no_answer: { label: "No answer", terminal: false },
  wrong_number: { label: "Wrong number", terminal: false },
  not_a_supplier: { label: "Cannot supply this", terminal: true },
} as const;

export type CallOutcome = keyof typeof CALL_OUTCOMES;

export interface CallAttempt {
  at: string;
  by: string | null;
  outcome: CallOutcome;
  note: string | null;
}

// A phone field can hold a channel note rather than a number ("via IndiaMART
// inquiry", "contact form"). Those are not dialable and must not reach an
// operator as if they were: require enough digits to be a real line.
export function dialablePhone(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/via |inquir|enquir|contact form|website/i.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return s;
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function daysSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / 86400000));
}

export interface BuildCallBriefInput {
  orgId: string;
  supplierId: string | null;
  // Agent 04's outreach draft metadata for the silent thread.
  meta: Record<string, any>;
  subject: string | null;
  threadId: string | null;
  // When the original sourcing inquiry went out, and when each nudge did.
  inquirySentAt: string | null;
  followupSentAt: string[];
  followupsSent: number;
  // Which call in the cadence this is (1-based). Stage 1 is the day-1 intro call,
  // made while the inquiry is still warm and regardless of whether they replied;
  // later stages are silence escalations. The two need different scripts, so an
  // operator on an intro call doesn't open with "we haven't heard from you".
  callStage?: number;
  // Whether the supplier has written back on this thread. Only ever true on an
  // intro call, since the silence stages don't fire once a reply lands.
  replied?: boolean;
  now?: Date;
}

// Pull the phone from wherever it landed. The lead payload is the freshest (an
// operator can edit it inline), the supplier profile is Agent 06's validated
// copy, and the Tenkara mirror is the original CRM value.
async function resolvePhone(
  admin: SupabaseClient,
  orgId: string,
  supplierId: string | null,
  supplierName: string | null,
  leadId: string | null
): Promise<{ contactPhone: string | null; source: CallBriefContact["phoneSource"]; country: string | null; website: string | null; region: string | null }> {
  let payload: any = null;
  if (leadId) {
    const { data } = await admin.from("leads_in_flight").select("payload").eq("id", leadId).maybeSingle();
    payload = (data as any)?.payload ?? null;
  }
  if (!payload && supplierId) {
    const { data } = await admin
      .from("leads_in_flight")
      .select("payload")
      .eq("org_id", orgId)
      .eq("supplier_id", supplierId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    payload = (data as any)?.payload ?? null;
  }

  const tenkara = payload?.enrichment?.tenkara_supplier ?? null;
  const country = payload?.supplier_country ?? tenkara?.country ?? null;
  const region = tenkara?.state ?? null;
  const website = payload?.supplier_website ?? payload?.source_url ?? null;

  const fromLead = dialablePhone(payload?.supplier_phone) ?? dialablePhone(payload?.enrichment?.contact?.phone);
  if (fromLead) return { contactPhone: fromLead, source: "lead_payload", country, website, region };

  let profileQuery = admin.from("supplier_profiles").select("poc_phone").eq("org_id", orgId).limit(1);
  profileQuery = supplierId ? profileQuery.eq("supplier_id", supplierId) : profileQuery.eq("supplier_name", supplierName ?? "");
  const { data: profile } = await profileQuery.maybeSingle();
  const fromProfile = dialablePhone((profile as any)?.poc_phone);
  if (fromProfile) return { contactPhone: fromProfile, source: "supplier_profile", country, website, region };

  const fromTenkara = dialablePhone(tenkara?.poc_phone);
  if (fromTenkara) return { contactPhone: fromTenkara, source: "tenkara_supplier", country, website, region };

  return { contactPhone: null, source: null, country, website, region };
}

export async function buildCallBrief(admin: SupabaseClient, input: BuildCallBriefInput): Promise<CallBrief> {
  const { meta, orgId, supplierId } = input;
  const now = input.now ?? new Date();
  const supplierName = (meta.supplier_name as string | null) ?? null;
  const leadId = (meta.lead_id as string | null) ?? null;

  const { contactPhone, source, country, website, region } = await resolvePhone(
    admin,
    orgId,
    supplierId,
    supplierName,
    leadId
  ).catch(() => ({ contactPhone: null, source: null as CallBriefContact["phoneSource"], country: null, website: null, region: null }));

  const materialNames: string[] = Array.isArray(meta.material_names)
    ? (meta.material_names as string[]).filter(Boolean)
    : meta.material_name
      ? [meta.material_name as string]
      : [];
  const materialList = materialNames.length ? materialNames.join(", ") : "the material we asked about";
  const contactName = (meta.supplier_contact_name as string | null) ?? null;
  const contactEmail = (meta.supplier_contact_email as string | null) ?? null;
  const ccContacts: string[] = Array.isArray(meta.cc_contacts) ? (meta.cc_contacts as string[]).filter(Boolean) : [];
  const reference = (meta.outreach_reference as string | null) ?? null;
  const requiredGrade = (meta.required_grade as string | null) ?? null;

  const context: string[] = [];
  const sentDate = fmtDate(input.inquirySentAt);
  context.push(
    `Sourcing inquiry sent ${sentDate ?? "earlier"}${contactEmail ? ` to ${contactEmail}` : ""}${contactName ? ` (${contactName})` : ""}.`
  );
  if (materialNames.length) {
    context.push(`Asked about ${materialList}${requiredGrade ? `, ${requiredGrade} grade required` : ""}.`);
  }
  if (input.subject) context.push(`Subject on the thread: "${input.subject}".`);
  if (reference) context.push(`Our reference: ${reference}.`);
  if (ccContacts.length) {
    context.push(`Also copied: ${ccContacts.join(", ")}. None of them replied either.`);
  }
  const nudgeDates = input.followupSentAt.map(fmtDate).filter(Boolean) as string[];
  if (nudgeDates.length) {
    context.push(
      `Email follow-up${nudgeDates.length === 1 ? "" : "s"} sent ${nudgeDates.join(" and ")}, still no reply.`
    );
  }
  const isIntro = (input.callStage ?? 1) === 1;
  if (input.replied) {
    context.push("They have already replied on this thread, so read it before dialling.");
  } else {
    const silentDays = daysSince(input.followupSentAt[input.followupSentAt.length - 1] ?? input.inquirySentAt, now.getTime());
    if (silentDays != null) {
      context.push(`Silent for ${silentDays} day${silentDays === 1 ? "" : "s"} since our last email.`);
    }
  }

  const purpose = input.replied
    ? "They have replied by email. This is the scheduled intro call, so use it to build the relationship and fill whatever the thread is still missing rather than re-asking what they already answered."
    : isIntro
      ? "Scheduled intro call, made the day after the sourcing inquiry went out while it is still fresh. The call is to reach a human, confirm the inquiry landed with the right person, and get the quote moving before we rely on email alone."
      : `Email is not landing. ${input.followupsSent + 1} messages sent, zero replies, so the address may be wrong, unmonitored, or filtered. The call is to find a human and confirm whether they can quote at all.`;

  const asks = input.replied
    ? [
        "Read the thread first and pick up where their reply left off.",
        `Fill any gap still outstanding on ${materialList}: price, pack size, MOQ, lead time.`,
      ]
    : [
        `Confirm they received our email about ${materialList}${contactEmail ? ` at ${contactEmail}` : ""}.`,
        "If that is the wrong address, get the name and direct email of whoever handles quotes.",
        `Ask whether they can supply ${materialList}, and if so request price, pack size, MOQ, and lead time.`,
      ];
  if (requiredGrade) {
    asks.push(`${requiredGrade} grade is a hard requirement. Do not accept an offer of a different grade.`);
  }
  asks.push("Log the outcome on this call task so the email sequence knows whether to resume.");

  return {
    contact: { name: contactName, email: contactEmail, phone: contactPhone, phoneSource: source },
    phoneStatus: contactPhone ? "known" : "missing",
    supplierName,
    supplierWebsite: website,
    country: country ?? null,
    window: buildCallWindow(country, region, now),
    context,
    purpose,
    asks,
    materialNames,
    requiredGrade,
    threadId: input.threadId,
    leadId,
    callStage: input.callStage ?? 1,
    builtAt: now.toISOString(),
  };
}

// One-line summary for Slack and any other plain-text surface.
export function callBriefHeadline(brief: CallBrief): string {
  const who = brief.supplierName ?? "supplier";
  const num = brief.contact.phone ?? "no number on file";
  const when = brief.window.timezone
    ? `${brief.window.localLabel} ${brief.window.timezone}${brief.window.etLabel ? ` (${brief.window.etLabel} ET)` : ""}`
    : "calling window unknown";
  return `Call ${who} on ${num}. Best window ${when}.`;
}
