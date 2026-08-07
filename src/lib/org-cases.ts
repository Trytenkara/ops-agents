import { operatorRoles, primaryRole } from "@/lib/operator";
import type { CaseRow } from "@/components/cases-list";
import type { CallCaseRow } from "@/components/calls-list";
import type { CallBrief, CallAttempt } from "@/lib/call-brief";
import { tenkaraInboxUrl } from "@/lib/tenkara";

// Escalations (the `cases` table) are split across four surfaces by what kind of
// problem they represent, so operators land on them where they already work:
//   call     → Call Tracker (a scheduled call task, or a supplier gone silent)
//   email    → Email Thread Tracker (a supplier reply / form needs a human)
//   supplier → Agent Supplier Leads "Supplier Escalations" (contact/lead gap)
//   quote    → Agent Quotes "Quotes Escalations" (a price couldn't be captured)
export type CaseCategory = "call" | "email" | "supplier" | "quote";

const EMAIL_CASE_TYPES = new Set(["supplier_form"]);
const QUOTE_CASE_TYPES = new Set([
  "marketplace_price_pull",
  "price_change",
  "lead_time_change",
  "availability_change",
  "quality_change",
  "po_timing",
]);

// manual_outreach (bounced, no working contact) and "other" (Agent 07 stale
// lead) are supplier-side gaps; anything unrecognized also defaults here so a
// new case type surfaces somewhere a human will see it rather than vanishing.
export function caseCategory(type: string | null | undefined): CaseCategory {
  if (type === "calling_escalation") return "call";
  if (type && EMAIL_CASE_TYPES.has(type)) return "email";
  if (type && QUOTE_CASE_TYPES.has(type)) return "quote";
  return "supplier";
}

const OPEN_SELECT =
  "id, supplier_id, type, recommended_action, status, created_at, resolved_at, resolution_note, metadata, assigned_operator, users:users!cases_assigned_operator_fkey(display_name, email, user_roles(role))";
const RESOLVED_SELECT =
  "id, supplier_id, type, recommended_action, status, resolved_at, resolution_note, metadata, users:users!cases_assigned_operator_fkey(display_name, email)";

// Load an org's open/in-progress cases and its recently-resolved ones once, so
// a page can split them by caseCategory() without three separate round-trips.
export async function loadOrgCases(admin: any, orgId: string): Promise<{ openRows: any[]; resolvedRows: any[] }> {
  const [openRes, resolvedRes] = await Promise.all([
    admin.from("cases").select(OPEN_SELECT).eq("org_id", orgId).in("status", ["open", "in_progress"]).order("created_at", { ascending: false }),
    admin.from("cases").select(RESOLVED_SELECT).eq("org_id", orgId).eq("status", "resolved").order("resolved_at", { ascending: false }).limit(50),
  ]);
  return { openRows: openRes.data ?? [], resolvedRows: resolvedRes.data ?? [] };
}

// Calling escalations are a phone worklist, not a row in a table: they render as
// their own cards on the Call Tracker tab.
export function isCallCase(c: any): boolean {
  return c?.type === "calling_escalation";
}

// Agent 13 already reads the real Tenkara threads and writes a per-supplier
// summary, open ask and thread state into supplier_email_context. Calls read it
// live rather than copying it into the case, because a brief written on day 1
// and dialled on day 5 would otherwise describe a thread that has moved since.
export type InboxContextLookup = {
  bySupplierId: Map<string, any>;
  byEmail: Map<string, any>;
};

export async function loadInboxContext(admin: any, orgId: string): Promise<InboxContextLookup> {
  const { data } = await admin
    .from("supplier_email_context")
    .select("supplier_id, supplier_email, thread_state, summary, open_ask, last_inbound_at, latest_conversation_id, updated_at")
    .eq("org_id", orgId);
  const bySupplierId = new Map<string, any>();
  const byEmail = new Map<string, any>();
  for (const r of (data ?? []) as any[]) {
    if (r.supplier_id && !bySupplierId.has(r.supplier_id)) bySupplierId.set(r.supplier_id, r);
    const email = (r.supplier_email as string | null)?.toLowerCase();
    if (email && !byEmail.has(email)) byEmail.set(email, r);
  }
  return { bySupplierId, byEmail };
}

function inboxFor(c: any, lookup?: InboxContextLookup) {
  if (!lookup) return null;
  const email = (c.metadata?.supplier_contact_email as string | undefined)?.toLowerCase();
  const row = (c.supplier_id && lookup.bySupplierId.get(c.supplier_id)) || (email && lookup.byEmail.get(email)) || null;
  if (!row) return null;
  const conversationId = row.latest_conversation_id ?? (c.metadata?.thread_id as string | undefined) ?? null;
  return {
    threadState: row.thread_state ?? null,
    summary: row.summary ?? null,
    openAsk: row.open_ask ?? null,
    lastInboundAt: row.last_inbound_at ?? null,
    conversationUrl: conversationId ? tenkaraInboxUrl(conversationId) : null,
    updatedAt: row.updated_at ?? null,
  };
}

export function toCallCaseRow(c: any, inboxLookup?: InboxContextLookup): CallCaseRow {
  return {
    id: c.id,
    inbox: inboxFor(c, inboxLookup),
    supplierId: c.supplier_id ?? null,
    supplierName: (c.metadata?.supplier_name as string | undefined) ?? null,
    status: c.status ?? "open",
    createdAt: c.created_at ?? null,
    assignedName: c.users?.display_name ?? null,
    assignedEmail: c.users?.email ?? null,
    assignedRole: primaryRole(operatorRoles(c.users)),
    materialName: (c.metadata?.material_name as string | undefined) ?? null,
    callStage: (c.metadata?.call_stage as number | undefined) ?? c.metadata?.call_brief?.callStage ?? 1,
    reason: (c.metadata?.reason as string | undefined) ?? null,
    threadId: (c.metadata?.thread_id as string | undefined) ?? null,
    draftId: (c.metadata?.draft_reference_id as string | undefined) ?? null,
    // Escalations raised before this shipped have no brief. The card degrades to
    // the recommended action rather than disappearing.
    brief: (c.metadata?.call_brief as CallBrief | undefined) ?? null,
    recommendedAction: c.recommended_action ?? null,
    callLog: Array.isArray(c.metadata?.call_log) ? (c.metadata.call_log as CallAttempt[]) : [],
  };
}

export function toCaseRow(c: any): CaseRow {
  return {
    id: c.id,
    supplierId: c.supplier_id ?? null,
    supplierName: (c.metadata?.supplier_name as string | undefined) ?? null,
    recommendedAction: c.recommended_action ?? null,
    staleDays: (c.metadata?.stale_days as number | undefined) ?? null,
    assignedName: c.users?.display_name ?? null,
    assignedEmail: c.users?.email ?? null,
    assignedRole: primaryRole(operatorRoles(c.users)),
    createdAt: c.created_at ?? null,
    formType: (c.metadata?.form_type as string | undefined) ?? null,
    formAvailable: c.type === "supplier_form" && !!c.metadata?.form_available,
    canAddEmail: c.type === "manual_outreach" && !!c.metadata?.lead_id,
  };
}
