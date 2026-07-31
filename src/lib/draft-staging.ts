import type { createAdminClient } from "@/lib/supabase/admin";
import { createMissiveDraft, missiveDraftLink } from "@/lib/missive";
import { createTenkaraDraft, createTenkaraConversation, setTenkaraConversationAssignee } from "@/lib/tenkara";
import { bodyToHtml } from "@/lib/email-style";
import { MISSIVE_ORGANIZATION_ID, MISSIVE_TEAM_ID } from "@/agents-runtime/agents/quote-revalidation/config";
import { lintDraft, type Finding } from "@/agents-runtime/agents/outreach-qa/lint";
import { approvedContactsFor } from "@/lib/contact-guard";
import { postAgentAlert } from "@/lib/slack-alert";

// Shared draft → QA building block. Every intake agent (02 expiries,
// 03 new-material outreach, 08 inbound replies) composes its own copy, then
// calls this to: stage a Missive draft (never sends), run the Agent 10 QA lint
// inline, and write the draft_references pointer with qa_findings attached.
//
// This replaces the duplicated Missive-create + draft_references-insert blocks
// that lived in agents 02 and 04, and means QA runs at creation time instead of
// only on the hourly sweep.

type Admin = ReturnType<typeof createAdminClient>;

// Auto-assign a Tenkara conversation to the operator the draft is assigned to in
// the Control Room, mirroring the assignment onto the email app at creation time
// (previously only a manual Control Room assign pushed the assignee). Best-effort:
// resolves the operator's login email, then PATCHes the conversation. A miss (no
// email on the operator, an email that isn't an active Tenkara member → 422, or a
// thread our token didn't create → 403) is logged, never thrown, so it can't roll
// back a staged draft.
export async function mirrorDraftAssignee(
  admin: Admin,
  threadId: string | null | undefined,
  operatorId: string | null | undefined
): Promise<void> {
  if (!threadId || !operatorId) return;
  const { data: op } = await admin.from("users").select("email").eq("id", operatorId).maybeSingle();
  const email = op?.email ?? null;
  if (!email) {
    console.warn(`[mirrorDraftAssignee] operator ${operatorId} has no email; skipped conversation ${threadId}`);
    return;
  }
  const res = await setTenkaraConversationAssignee(threadId, email);
  if (!res.ok) {
    console.warn(`[mirrorDraftAssignee] Tenkara assignee mirror failed for conversation ${threadId}: ${res.status} ${res.error}`);
  }
}

export interface StageDraftInput {
  admin: Admin;
  agentId: string | null;
  runId: string | null;
  orgId: string | null;
  supplierId?: string | null;
  materialId?: string | null;
  quoteId?: string | null;
  to: { name?: string | null; address: string };
  // Extra recipients CC'd on the SAME thread (multi-contact outreach). All must
  // be legitimate supplier addresses — they're added to the anti-fabrication
  // allowlist just like the To: address.
  cc?: { name?: string | null; address: string }[];
  subject: string;
  body: string; // plain text; converted to HTML for the email client, sliced for preview
  assignedOperator?: string | null;
  // Which email app to stage into. "missive" (default) POSTs a Missive draft;
  // "rod_app" POSTs a Tenkara draft and requires conversationId (Phase 1 = replies only).
  emailClient?: "missive" | "rod_app";
  // For emailClient="rod_app": pass conversationId to reply into an existing thread,
  // OR externalId to create a brand-new cold-outbound conversation. One is required.
  conversationId?: string | null;
  externalId?: string | null; // idempotency key for cold-outbound conversation creates
  // For emailClient="rod_app" cold outbound: the Tenkara inbox UUID to send from
  // (resolved by the caller from the sending brand). Omit → operator picks at review.
  emailAccountId?: string | null;
  // For emailClient="rod_app" cold outbound: supplier contact card written to the
  // supplier record. Email defaults to the recipient; omitted fields take defaults.
  supplierCompany?: string | null;
  // Caller-supplied metadata (outreach_mode, ghost_brand, lead_id, etc.).
  // qa_findings + the draft link are merged in here.
  metadata?: Record<string, any>;
}

export interface StageDraftResult {
  ok: boolean;
  error?: string;
  draftRefId?: string;
  draftId?: string;           // the email client's draft id (Missive draft id or Tenkara draft UUID)
  missiveDraftId?: string;    // kept for back-compat with existing Missive callers
  conversationId?: string | null;
  qaFindings?: Finding[];
  // True when the anti-fabrication guard held the draft: no provider draft was
  // created and the draft_references row is status="blocked" (not sendable).
  blocked?: boolean;
}

export async function stageDraft(input: StageDraftInput): Promise<StageDraftResult> {
  const { admin, agentId, runId, orgId, supplierId, materialId, quoteId, to, subject, body, assignedOperator } = input;
  const callerMeta = input.metadata ?? {};
  const emailClient = input.emailClient ?? "missive";

  // Allowlist for the anti-fabrication guard: per-brand/org approved contact
  // values plus the recipient's own address (echoing that back is legitimate).
  const ccList = (input.cc ?? []).filter((c) => c.address && c.address.toLowerCase() !== to.address.toLowerCase());
  const ccString = ccList.map((c) => (c.name ? `${c.name} <${c.address}>` : c.address)).join(", ");
  const approvedContacts = [
    ...approvedContactsFor([callerMeta.ghost_brand as string | undefined, orgId]),
    to.address,
    ...ccList.map((c) => c.address),
  ];
  const lintMeta = { ...callerMeta, approved_contacts: approvedContacts };

  // Lint at creation time, on the same shape the scheduled QA sweep uses.
  const qaFindings = lintDraft({
    subject,
    body_preview: body,
    assigned_operator: assignedOperator ?? null,
    metadata: lintMeta,
  });

  // Steadfast hard block: if the draft states a shipping address / phone / email
  // that isn't approved, it was almost certainly fabricated. Do NOT create a
  // provider draft (that would leave un-deletable junk in Tenkara and a
  // manually-sendable draft) — record a blocked row and alert ops to research it.
  const fabrication = qaFindings.find((f) => f.code === "fabricated_contact_info");
  if (fabrication) {
    const { data, error } = await admin
      .from("draft_references")
      .insert({
        email_client: emailClient,
        thread_id: input.conversationId ?? `blocked:${input.externalId ?? "reply"}`,
        draft_id: `blocked:${runId ?? agentId ?? "agent"}`,
        agent_id: agentId,
        agent_run_id: runId,
        org_id: orgId,
        supplier_id: supplierId ?? null,
        material_id: materialId ?? null,
        quote_id: quoteId ?? null,
        subject,
        body_preview: body.slice(0, 1500),
        assigned_operator: assignedOperator ?? null,
        status: "blocked",
        metadata: { ...callerMeta, approved_contacts: approvedContacts, qa_findings: qaFindings, qa_linted_at: new Date().toISOString() },
      })
      .select("id")
      .maybeSingle();

    const brand = (callerMeta.ghost_brand as string | undefined) ?? (callerMeta.supplier_name as string | undefined) ?? "a supplier draft";
    await postAgentAlert(
      `:no_entry: Blocked a supplier draft with unverified contact info (possible fabrication). ${fabrication.message} — brand: ${brand}, supplier: ${callerMeta.supplier_name ?? "?"}, draft_ref: ${data?.id ?? "?"}. Held (status=blocked); not sent. Research the real value and add it to BRAND_CONTACTS if legitimate.`,
      { channel: process.env.SLACK_CONTACT_GUARD_CHANNEL_ID ?? "C0B5M1QCE9E" },
    );

    if (error) return { ok: false, error: `draft_references(blocked): ${error.message}`, qaFindings, blocked: true };
    return { ok: true, draftRefId: data?.id, qaFindings, blocked: true };
  }

  // Create the draft in the target email app. Both paths only stage — never send.
  let draftId: string;
  let threadId: string;
  let draftLink: string | null = null;
  const extraMeta: Record<string, any> = {};
  try {
    if (emailClient === "rod_app") {
      if (input.conversationId) {
        // Reply into an existing Tenkara conversation.
        const t = await createTenkaraDraft({
          conversationId: input.conversationId,
          to: { name: to.name ?? "", address: to.address },
          subject,
          bodyHtml: bodyToHtml(body),
          bodyText: body,
          cc: ccString || undefined,
        });
        draftId = t.id;
        threadId = t.conversationId;
      } else if (input.externalId) {
        // Cold outbound: create a brand-new conversation + draft.
        const c = await createTenkaraConversation({
          externalId: input.externalId,
          to: { name: to.name ?? "", address: to.address },
          subject,
          bodyHtml: bodyToHtml(body),
          bodyText: body,
          cc: ccString || undefined,
          emailAccountId: input.emailAccountId ?? undefined,
          supplierContact: { email: to.address, name: to.name ?? null, company: input.supplierCompany ?? null },
          context: { org_id: orgId, supplier_id: supplierId ?? null, material_id: materialId ?? null, quote_id: quoteId ?? null, ...callerMeta },
        });
        draftId = c.draftId;
        threadId = c.conversationId;
        extraMeta.draft_kind = callerMeta.draft_kind ?? "cold_outbound";
        extraMeta.external_id = input.externalId;
        extraMeta.requires_sender_selection = c.requiresSenderSelection;
      } else {
        return { ok: false, error: "rod_app drafts require conversationId (reply) or externalId (cold outbound)", qaFindings };
      }
    } else {
      const m = await createMissiveDraft({
        subject,
        body: bodyToHtml(body),
        to_fields: [{ name: to.name ?? "", address: to.address }],
        cc_fields: ccList.length ? ccList.map((c) => ({ name: c.name ?? "", address: c.address })) : undefined,
        organization: MISSIVE_ORGANIZATION_ID,
        team: MISSIVE_TEAM_ID,
        add_to_team_inbox: true,
      });
      draftId = m.id;
      threadId = m.conversation_id ?? "";
      draftLink = m.conversation_id ? missiveDraftLink(m.conversation_id, m.id) : null;
    }
  } catch (e: any) {
    return { ok: false, error: `${emailClient}: ${e?.message ?? e}`, qaFindings };
  }

  const metadata = {
    ...callerMeta,
    approved_contacts: approvedContacts,
    qa_findings: qaFindings,
    qa_linted_at: new Date().toISOString(),
    missive_draft_link: draftLink,
    // Record who we actually CC'd so the reply/follow-up loop knows which
    // supplier contacts have already been reached on this thread.
    ...(ccList.length ? { cc_contacts: ccList.map((c) => c.address) } : {}),
    ...extraMeta,
  };

  const { data, error } = await admin
    .from("draft_references")
    .insert({
      email_client: emailClient,
      thread_id: threadId,
      draft_id: draftId,
      agent_id: agentId,
      agent_run_id: runId,
      org_id: orgId,
      supplier_id: supplierId ?? null,
      material_id: materialId ?? null,
      quote_id: quoteId ?? null,
      subject,
      body_preview: body.slice(0, 1500),
      assigned_operator: assignedOperator ?? null,
      metadata,
    })
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: `draft_references: ${error.message}`, qaFindings };

  // Mirror the Control Room operator onto the Tenkara conversation so the email
  // app shows the same assignee the moment the draft is staged.
  if (emailClient === "rod_app") {
    await mirrorDraftAssignee(admin, threadId, assignedOperator ?? null);
  }

  return {
    ok: true,
    draftRefId: data?.id,
    draftId,
    missiveDraftId: emailClient === "missive" ? draftId : undefined,
    conversationId: threadId || null,
    qaFindings,
  };
}
