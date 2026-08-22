import type { createAdminClient } from "@/lib/supabase/admin";
import { createTenkaraDraft, createTenkaraConversation, setTenkaraConversationAssignee } from "@/lib/tenkara";
import { bodyToHtml, sanitizeDraft } from "@/lib/email-style";
import { isPlatformOwnedContact } from "@/lib/aggregator-hosts";
import { lintDraft, type Finding } from "@/agents-runtime/agents/outreach-qa/lint";
import { approvedContactsFor } from "@/lib/contact-guard";
import { postAgentAlert } from "@/lib/slack-alert";
import { scopedSupplierId } from "@/lib/tenkara-supplier-linker";
import { orgScopedExternalId } from "@/lib/org-isolation";
import { loadThreadContext } from "@/lib/thread-context";
import { tailorToThread, needsTailorRetry } from "@/lib/thread-tailor";
import { isDraftSuppressed } from "@/lib/draft-suppression";
import { isDoNotContact, tenkaraOrgIdFor } from "@/lib/do-not-contact";
import { cappedRead } from "@/lib/capped-read";
import { resolveMaterialGradeSpecs } from "@/lib/tenkara-names";

// Shared draft → QA building block. Every intake agent (02 expiries,
// 04 new-material outreach) and the Tenkara inbound webhook composes its own
// copy, then calls this to: stage a Tenkara draft (never sends), run the Agent 10
// QA lint inline, and write the draft_references pointer with qa_findings
// attached. QA therefore runs at creation time, not only on the hourly sweep.

type Admin = ReturnType<typeof createAdminClient>;

// QA findings that hold the draft instead of merely flagging it. Everything
// else is advisory and surfaces as a pill in the Control Room.
const BLOCKING_CODES = new Set(["fabricated_contact_info", "grade_ask_widened"]);

// A sample of the foreign drafts on a replayed conversation, not the count of
// them: the count comes back exact on the same request (PERS-06).
const CROSS_ORG_SAMPLE = 50;

const BLOCKED_DIGEST_GROUP = "Drafts held for unverified contacts";

// Auto-assign a Tenkara conversation to the operator the draft is assigned to in
// the Control Room, mirroring the assignment onto the email app at creation time
// (previously only a manual Control Room assign pushed the assignee). Best-effort:
// resolves the operator's login email, then PATCHes the conversation. A miss (no
// email on the operator, an email that isn't an active Tenkara member → 422, or a
// thread our token didn't create → 403) is logged, never thrown, so it can't roll
// back a staged draft.
// Returns whether Tenkara now agrees with us. Callers that mirror one draft can
// keep ignoring it; a bulk reassignment needs to know which threads to retry, or
// Control Room and the inbox disagree on who owns the conversation.
export async function mirrorDraftAssignee(
  admin: Admin,
  threadId: string | null | undefined,
  operatorId: string | null | undefined
): Promise<boolean> {
  // A "blocked:" id is a placeholder for a draft that never reached Tenkara, so
  // there is no conversation to mirror onto.
  if (!threadId || !operatorId || threadId.startsWith("blocked:")) return true;
  const { data: op } = await admin.from("users").select("email").eq("id", operatorId).maybeSingle();
  const email = op?.email ?? null;
  if (!email) {
    console.warn(`[mirrorDraftAssignee] operator ${operatorId} has no email; skipped conversation ${threadId}`);
    return false;
  }
  const res = await setTenkaraConversationAssignee(threadId, email);
  if (!res.ok) {
    console.warn(`[mirrorDraftAssignee] Tenkara assignee mirror failed for conversation ${threadId}: ${res.status} ${res.error}`);
  }
  return res.ok;
}

// Everyone we've already CC'd on a Tenkara thread, unioned across every draft we
// staged onto it. Cold outreach puts the extra supplier contacts in CC and records
// them as metadata.cc_contacts; without replaying that list, each agent reply goes
// only to whoever wrote back and silently drops the rest of the supplier's team off
// the thread. Unioning across rows (rather than reading one) matters because the
// row a reply matched on may itself be an earlier reply.
export async function threadCcContacts(
  admin: Admin,
  threadId: string | null | undefined,
  exclude?: string | null
): Promise<string[]> {
  if (!threadId) return [];
  const { data, error } = await admin
    .from("draft_references")
    .select("metadata")
    .eq("email_client", "rod_app")
    .eq("thread_id", threadId);
  if (error || !data) return [];

  const skip = exclude?.toLowerCase();
  const seen = new Map<string, string>();
  for (const row of data as any[]) {
    for (const addr of (row?.metadata?.cc_contacts ?? []) as string[]) {
      const key = typeof addr === "string" ? addr.trim().toLowerCase() : "";
      if (!key || key === skip || seen.has(key)) continue;
      seen.set(key, addr.trim());
    }
  }
  return [...seen.values()];
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
  // Pass conversationId to reply into an existing Tenkara thread, OR externalId to
  // create a brand-new cold-outbound conversation. One is required.
  conversationId?: string | null;
  externalId?: string | null; // idempotency key for cold-outbound conversation creates
  // Cold outbound: the Tenkara inbox UUID to send from (resolved by the caller from
  // the sending brand). Omit → operator picks at review.
  emailAccountId?: string | null;
  // Cold outbound: supplier contact card written to the supplier record. Email
  // defaults to the recipient; omitted fields take defaults.
  supplierCompany?: string | null;
  // Caller-supplied metadata (outreach_mode, ghost_brand, lead_id, etc.).
  // qa_findings + the draft link are merged in here.
  metadata?: Record<string, any>;
  // Set by a drafter that already composed against the full thread (the inbound
  // reply path), so the staging tailor doesn't run a second model pass over
  // copy that is already conversation-aware. Everything else, including every
  // template-built follow-up, is tailored here.
  threadAware?: boolean;
}

export interface StageDraftResult {
  ok: boolean;
  error?: string;
  draftRefId?: string;
  draftId?: string;           // the Tenkara draft UUID
  conversationId?: string | null;
  qaFindings?: Finding[];
  // True when an operator already discarded this exact draft, so nothing was
  // composed or staged. Not a failure: callers log it as a skip.
  suppressed?: boolean;
  // True when the anti-fabrication guard held the draft: no provider draft was
  // created and the draft_references row is status="blocked" (not sendable).
  blocked?: boolean;
}

/**
 * The grade a client has marked a dealbreaker, for every material in the draft.
 *
 * Three states, not two (the DISC-09 shape): a grade, no grade, or we could not
 * ask. An unreachable Tenkara used to be indistinguishable from "nothing is a
 * dealbreaker", which unarms the widening block silently. It is recorded here
 * so the audit can count the drafts nobody could check rather than reading them
 * as clean.
 */
async function resolveRequiredGrade(
  callerMeta: Record<string, unknown>,
  materialId: string | null
): Promise<Record<string, unknown>> {
  const already = typeof callerMeta.required_grade === "string" ? callerMeta.required_grade.trim() : "";
  if (already) return {};
  const ids = Array.from(
    new Set(
      [
        ...(Array.isArray(callerMeta.material_ids) ? (callerMeta.material_ids as string[]) : []),
        materialId,
      ].filter((x): x is string => !!x)
    )
  );
  if (ids.length === 0) return {};
  try {
    const specs = await resolveMaterialGradeSpecs(ids);
    const required = Array.from(
      new Set(ids.flatMap((id) => (specs.get(id)?.required ?? "").split(", ").filter(Boolean)))
    ).join(", ");
    return required ? { required_grade: required } : {};
  } catch (e: any) {
    return { grade_spec_unavailable: String(e?.message ?? e).slice(0, 200) };
  }
}

export async function stageDraft(input: StageDraftInput): Promise<StageDraftResult> {
  const { admin, agentId, runId, orgId, materialId, quoteId, to, assignedOperator } = input;
  const callerMeta = input.metadata ?? {};

  // An operator already threw this exact draft away. Checked before anything
  // else so a rejected draft costs no model pass and never reaches the inbox a
  // second time. See draft-suppression for the three cases that are NOT a
  // repeat: our own discards, a different recipient, and a reply to a fresh
  // supplier message.
  const suppression = await isDraftSuppressed(admin, {
    orgId,
    supplierId: input.supplierId ?? null,
    threadId: input.conversationId ?? null,
    kind: (callerMeta.draft_kind as string | undefined) ?? null,
    toAddress: to.address,
    // Outreach consolidates several materials into one email, so the whole pool
    // decides whether this is the same email that was thrown away.
    materialIds: [
      ...(Array.isArray(callerMeta.material_ids) ? (callerMeta.material_ids as string[]) : []),
      materialId ?? null,
    ],
  });
  if (suppression.suppressed) {
    console.warn(
      `[stageDraft] skipped ${callerMeta.draft_kind} to ${to.address}: ${suppression.reason} at ${suppression.discardedAt}`
    );
    return { ok: false, suppressed: true, error: `suppressed:${suppression.reason}` };
  }

  // Do-not-contact, both the client's own list and the one ops writes. Checked
  // here as well as at discovery, because discovery only covers new leads: a
  // company added to the list after outreach started kept getting follow-ups.
  if (orgId) {
    const dnc = await isDoNotContact(admin, {
      orgId,
      tenkaraOrgId: await tenkaraOrgIdFor(admin, orgId),
      supplierId: input.supplierId ?? null,
      companyName: input.supplierCompany ?? (to.name ?? null),
      website: (callerMeta.supplier_website as string | undefined) ?? null,
      email: to.address,
    });
    if (dnc.blocked) {
      console.warn(`[stageDraft] skipped ${callerMeta.draft_kind} to ${to.address}: ${dnc.source}`);
      return { ok: false, suppressed: true, error: `suppressed:${dnc.source}` };
    }
  }

  // A platform is never the supplier (DISC-05), and its inbox is never the
  // supplier's contact. Enforced here rather than at each write site because
  // there are eighteen places a contact email is stamped on a lead and one
  // place an email is sent. A directory address reaches the directory: the
  // manufacturer may never hear about it, and the reply comes back from the
  // platform, which then reads as the supplier.
  const platformContact = isPlatformOwnedContact(to.address, input.supplierCompany ?? to.name ?? null);
  if (platformContact.blocked) {
    console.warn(
      `[stageDraft] skipped ${callerMeta.draft_kind} to ${to.address}: that is ${platformContact.platform}'s own address, not ${input.supplierCompany ?? to.name ?? "the supplier"}'s`
    );
    return { ok: false, suppressed: true, error: `suppressed:platform_owned_contact:${platformContact.platform}` };
  }

  // Style rules (no "RFQ", no em dash) are enforced HERE, at the one chokepoint
  // every outbound draft passes through, not in each drafter. Three drafters
  // called sanitizeDraft themselves and any new one could simply forget to.
  // Sanitizing is idempotent, so the existing callers stay correct.
  let { subject, body } = sanitizeDraft({ subject: input.subject, body: input.body });

  // No draft into an existing conversation may ignore what the supplier already
  // said. Enforced HERE for the same reason sanitizeDraft is: the three
  // template follow-ups had no thread awareness at all, and a fourth drafter
  // would have started out the same way. Best-effort by design, a failed load
  // or a rejected rewrite keeps the original copy and records why.
  let tailorNote: Record<string, any> | null = null;
  if (input.conversationId && !input.threadAware) {
    const ctx = await loadThreadContext(input.conversationId);
    if (!ctx.ok) {
      tailorNote = { tailored: false, reason: "thread_context_unavailable", error: ctx.error };
      console.warn(`[stageDraft] thread context load failed for ${input.conversationId}: ${ctx.error}`);
    } else if (ctx.text) {
      const t = await tailorToThread({ body, threadContext: ctx.text });
      if (t.tailored) {
        // Re-sanitize: the rewrite is model output and gets the same treatment
        // as any other drafter's copy.
        body = sanitizeDraft({ subject, body: t.body }).body;
      }
      tailorNote = { tailored: t.tailored, reason: t.reason ?? null, attempts: t.attempts ?? null };
    }
  }

  // draft_references.supplier_id is the key the inbound-reply path merges quote
  // details and supplier profiles on, but discovery hands most leads over
  // name-only, so the pointer was written with a null id and the reply had
  // nothing to merge onto. Resolve the name against Tenkara's supplier table at
  // staging time. Best-effort: a miss keeps the previous null behaviour.
  //
  // An id the caller already holds is checked, not trusted: quote rows carry the
  // supplier id of whoever quoted the material, which is not always this client.
  let supplierId: string | null = null;
  {
    const name = input.supplierCompany ?? (callerMeta.supplier_name as string | undefined) ?? null;
    try {
      supplierId = await scopedSupplierId(admin, orgId, input.supplierId ?? null, name);
    } catch {
      supplierId = null;
    }
  }

  // Allowlist for the anti-fabrication guard: per-brand/org approved contact
  // values plus the recipient's own address (echoing that back is legitimate).
  const ccList = (input.cc ?? []).filter((c) => c.address && c.address.toLowerCase() !== to.address.toLowerCase());
  const ccString = ccList.map((c) => (c.name ? `${c.name} <${c.address}>` : c.address)).join(", ");
  const approvedContacts = [
    ...approvedContactsFor([callerMeta.ghost_brand as string | undefined, orgId]),
    to.address,
    ...ccList.map((c) => c.address),
  ];
  // DATA-08. The dealbreaker grade used to be resolved by the cold-outbound
  // drafter alone, so that was the only draft kind the widening block could arm
  // on. Over 30 days 521 no-reply follow-ups, 330 call follow-ups, 317 replies
  // and 31 stalled chases went out with the guard switched off — and a chase is
  // exactly where "let us know what else you stock in this range" gets written.
  // It is resolved here instead, at the one chokepoint every draft path passes
  // through. A caller that already resolved it still wins.
  const gradeMeta = await resolveRequiredGrade(callerMeta, materialId ?? null);
  const meta = { ...callerMeta, ...gradeMeta };
  const lintMeta = { ...meta, approved_contacts: approvedContacts };

  // Lint at creation time, on the same shape the scheduled QA sweep uses.
  const qaFindings = lintDraft({
    subject,
    body_preview: body,
    assigned_operator: assignedOperator ?? null,
    metadata: lintMeta,
  });

  // Steadfast hard blocks. Do NOT create a provider draft for these (that would
  // leave un-deletable junk in Tenkara and a manually-sendable draft) — record a
  // blocked row and alert ops. Two cases: contact info that isn't on the
  // approved allowlist (almost certainly fabricated), and copy that widens the
  // ask past the client's dealbreaker grade.
  const fabrication = qaFindings.find((f) => BLOCKING_CODES.has(f.code));
  if (fabrication) {
    // Agent 04's "already contacted" filter counts staged/reviewed/sent/linked
    // and deliberately not blocked, so it re-picks a held supplier on its next
    // run. At */5 that inserted a fresh blocked row every 5 minutes for as long
    // as the contact stayed unverified. Reuse the existing row instead: the
    // verdict only changes when a human adds the real contact, and that changes
    // the lint result, not this row.
    const blockedThreadId =
      input.conversationId ?? `blocked:${input.externalId ? orgScopedExternalId(orgId, input.externalId) : "reply"}`;
    // Match on org + material too, not the thread alone: one conversation carries
    // many drafts for many materials, and a `blocked:<externalId>` placeholder has
    // no org component at all, so two clients would collide on one row.
    let priorQuery = admin
      .from("draft_references")
      .select("id, metadata")
      .eq("email_client", "rod_app")
      .eq("status", "blocked")
      .eq("thread_id", blockedThreadId);
    priorQuery = orgId ? priorQuery.eq("org_id", orgId) : priorQuery.is("org_id", null);
    priorQuery = materialId ? priorQuery.eq("material_id", materialId) : priorQuery.is("material_id", null);
    const { data: priorBlocked } = await priorQuery.order("created_at", { ascending: false }).limit(1);
    const prior = (priorBlocked ?? [])[0] as any;
    const priorSameCode = ((prior?.metadata?.qa_findings ?? []) as Finding[]).some((f) => f.code === fabrication.code);

    const brand = (callerMeta.ghost_brand as string | undefined) ?? (callerMeta.supplier_name as string | undefined) ?? "a supplier draft";
    const supplierLabel = (callerMeta.supplier_name as string | undefined) ?? supplierId ?? to.address;

    let inserted: { id: string } | null = null;
    let insertError: string | null = null;
    if (!(prior && priorSameCode)) {
      const { data, error } = await admin
        .from("draft_references")
        .insert({
          email_client: "rod_app",
          thread_id: blockedThreadId,
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
          metadata: { ...meta, approved_contacts: approvedContacts, qa_findings: qaFindings, qa_linted_at: new Date().toISOString() },
        })
        .select("id")
        .maybeSingle();
      inserted = (data as { id: string } | null) ?? null;
      insertError = error?.message ?? null;
    }

    const draftRefId = inserted?.id ?? prior?.id ?? null;
    // Dispatched on the reuse path as well as the insert path. Held drafts are
    // reused for as long as the contact stays unverified, so alerting only on
    // insert would name a supplier once and then never again, which is how one
    // gets quietly forgotten. The ledger TTL, not this branch, decides how often
    // it is repeated (daily).
    //
    // Keyed on org + supplier + block reason, not the draft: outreach re-attempts
    // the same supplier every run, and one line per supplier per day in the digest
    // is the whole point. Never a live post; a held draft is not urgent, it just
    // needs someone to research the real contact eventually.
    const orgLabel = orgId
      ? (await admin.from("orgs").select("name").eq("id", orgId).maybeSingle()).data?.name ?? orgId.slice(0, 8)
      : "no org";
    await postAgentAlert(
      `:no_entry: Blocked a supplier draft (${fabrication.code}). ${fabrication.message} Brand: ${brand}, supplier: ${supplierLabel}, draft_ref: ${draftRefId ?? "?"}. Held (status=blocked), not sent.`,
      {
        severity: "p2",
        key: `blocked_draft:${orgId ?? "none"}:${fabrication.code}:${supplierLabel}`,
        digestGroup: BLOCKED_DIGEST_GROUP,
        // The body never reaches Slack for a p2, so the title has to stand alone:
        // whose client, which supplier, why, and the row to look up.
        title: `*${orgLabel}* · ${supplierLabel} · ${fabrication.code} · draft_ref \`${(draftRefId ?? "?").slice(0, 8)}\``,
      },
    );

    if (prior && priorSameCode) return { ok: true, draftRefId: prior.id, qaFindings, blocked: true };
    if (insertError) return { ok: false, error: `draft_references(blocked): ${insertError}`, qaFindings, blocked: true };
    return { ok: true, draftRefId: draftRefId ?? undefined, qaFindings, blocked: true };
  }

  // Create the draft in Tenkara. Only ever stages — never sends.
  let draftId: string;
  let threadId: string;
  const extraMeta: Record<string, any> = {};
  try {
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
      // Tenkara is idempotent on externalId, so an unscoped key lets a second
      // client adopt the first client's conversation and draft. Scoped HERE, at
      // the one chokepoint every cold-outbound draft passes through, rather than
      // trusting each caller to remember.
      const scopedExternalId = orgScopedExternalId(orgId, input.externalId);
      const c = await createTenkaraConversation({
        externalId: scopedExternalId,
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
      extraMeta.external_id = scopedExternalId;
      extraMeta.requires_sender_selection = c.requiresSenderSelection;
      extraMeta.idempotent_replay = c.idempotent;
      // Tenkara tells us when a create replayed an existing conversation, and we
      // ignored it for months — which is how one client silently inherited
      // another client's draft. With the key org-scoped a replay should only ever
      // be this org retrying, so a replay landing on a conversation we have
      // recorded under a DIFFERENT org means the scoping has been defeated
      // somewhere else. Alert loudly rather than stage into it.
      if (c.idempotent && threadId) {
        // PERS-06: the blast radius of an isolation breach is the number this
        // alert exists to report, so it is counted in the database and not by
        // filtering a capped page in JS. The old read took 50 rows before the
        // org filter, so a busy thread's own-org drafts could crowd the foreign
        // ones out entirely and the alert would read zero.
        const foreignQuery = admin
          .from("draft_references")
          .select("id, org_id", { count: "exact" })
          .eq("email_client", "rod_app")
          .eq("thread_id", threadId)
          .order("created_at", { ascending: false })
          .limit(CROSS_ORG_SAMPLE);
        const foreignRead = await cappedRead<{ id: string; org_id: string | null }>(
          orgId ? foreignQuery.or(`org_id.neq.${orgId},org_id.is.null`) : foreignQuery.not("org_id", "is", null),
          CROSS_ORG_SAMPLE,
          "foreign drafts on this conversation",
        );
        if (foreignRead.total > 0) {
          extraMeta.cross_org_replay = true;
          extraMeta.cross_org_draft_count = foreignRead.total;
          await postAgentAlert(
            `:rotating_light: Cross-client conversation reuse: a draft for org ${orgId ?? "none"} replayed conversation ${threadId}, which already carries ${foreignRead.total} draft(s) from another client. External id: ${scopedExternalId}.`,
            {
                    severity: "p1",
              key: `cross_org_replay:${threadId}`,
              title: `Cross-client conversation reuse on \`${threadId.slice(0, 8)}\``,
            },
          );
        }
      }
      if (c.conversationUrl) extraMeta.conversation_url = c.conversationUrl;
    } else {
      return { ok: false, error: "drafts require conversationId (reply) or externalId (cold outbound)", qaFindings };
    }
  } catch (e: any) {
    return { ok: false, error: `tenkara: ${e?.message ?? e}`, qaFindings };
  }

  const metadata = {
    ...meta,
    approved_contacts: approvedContacts,
    qa_findings: qaFindings,
    qa_linted_at: new Date().toISOString(),
    ...(tailorNote
      ? {
          thread_tailor: tailorNote,
          // Queryable rather than silent: a draft that missed tailoring because
          // the ATTEMPT failed is flagged for a later redraft (PERS-01/PERS-02,
          // a flag must not be a queue exit).
          ...(needsTailorRetry(tailorNote) ? { thread_tailor_retry: true } : {}),
        }
      : {}),
    // Record who we actually CC'd so the reply/follow-up loop knows which
    // supplier contacts have already been reached on this thread.
    ...(ccList.length ? { cc_contacts: ccList.map((c) => c.address) } : {}),
    ...extraMeta,
  };

  const { data, error } = await admin
    .from("draft_references")
    .insert({
      email_client: "rod_app",
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
  await mirrorDraftAssignee(admin, threadId, assignedOperator ?? null);

  return {
    ok: true,
    draftRefId: data?.id,
    draftId,
    conversationId: threadId || null,
    qaFindings,
  };
}
