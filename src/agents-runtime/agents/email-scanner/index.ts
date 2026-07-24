import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { listTeamConversations, getConversationMessages } from "@/lib/missive";
import { MISSIVE_TEAM_ID, MISSIVE_REPLY_SCAN_TEAM_IDS } from "../quote-revalidation/config";
import { composeReply } from "./reply-drafter";
import { stageDraft } from "@/lib/draft-staging";
import { parseMessageAttachments } from "./attachment-parser";
import { insertStagedQuotes, type StagedQuoteInput } from "@/lib/staged-quotes";
import { missivePollingEnabled } from "@/lib/tenkara";

// Agent 08 — Email Scanner (v1)
//
// Why broad inbox scan and not thread-only:
//   Suppliers don't always reply in-thread. They may start a fresh chain
//   ("re: looking for caffeine — circling back"), forward to a colleague who
//   replies, or just compose a new email. Thread-based reply detection misses
//   all of these. So we match on sender email instead: any sent message from
//   an address we have outreach to is a reply candidate.
//
// Algorithm:
//   1. Load cursor from agent_state (default: 7d ago).
//   2. Build outreach_emails: lower(supplier_email) → [draft_reference rows]
//      for every non-discarded draft_references row.
//   3. Pull team_inbox conversations newer than cursor.
//   4. For each conversation, pull messages, skip drafts, skip messages older
//      than cursor. If from_field.address (lower) is in outreach_emails, this
//      is a supplier reply → stamp draft_references.metadata + leads_in_flight.
//   5. Update cursor to max last_activity_at observed.
//
// On a detected reply it also DRAFTS a response (composeReply → stageDraft) for
// the operator to review and send — deduped via metadata.reply_draft so a reply
// is only drafted once.
//
// Safety:
//   - Missive: read for scanning; the only POST is staging a draft (never sends;
//     the Missive client refuses send/from_field at compile + runtime).
//   - Writes only to OA (draft_references + leads_in_flight.payload + agent_state).
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_CONVERSATIONS_PER_RUN = 50;

// Our own outbound sender addresses — a message from one of these is our
// outreach, not a supplier reply, so it never counts as a match (important now
// that we also match by thread/domain). Override via MISSIVE_OUR_ADDRESSES (csv).
const OUR_SENDER_ADDRESSES = new Set(
  (process.env.MISSIVE_OUR_ADDRESSES?.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) ?? [])
    .concat(["info@bobberlabs.com"])
);

interface CursorValue {
  last_activity_at: number; // unix seconds
  last_run_at: string; // iso
}

function cursorKey(teamId: string): string {
  return `team_${teamId}_last_scan`;
}

async function loadCursor(admin: ReturnType<typeof createAdminClient>, agentId: string, teamId: string): Promise<number> {
  const { data } = await admin
    .from("agent_state")
    .select("value")
    .eq("agent_id", agentId)
    .eq("key", cursorKey(teamId))
    .maybeSingle();
  const v = (data?.value ?? null) as CursorValue | null;
  if (v?.last_activity_at) return v.last_activity_at;
  return Math.floor(Date.now() / 1000) - DEFAULT_LOOKBACK_DAYS * 24 * 3600;
}

async function saveCursor(
  admin: ReturnType<typeof createAdminClient>,
  agentId: string,
  teamId: string,
  lastActivityAt: number
): Promise<void> {
  await admin
    .from("agent_state")
    .upsert(
      {
        agent_id: agentId,
        key: cursorKey(teamId),
        value: { last_activity_at: lastActivityAt, last_run_at: new Date().toISOString() } satisfies CursorValue,
      },
      { onConflict: "agent_id,key" }
    );
}

interface DraftRefRow {
  id: string;
  org_id: string | null;
  supplier_id: string | null;
  material_id: string | null;
  metadata: Record<string, any> | null;
  status: string;
  subject: string | null;
  assigned_operator: string | null;
}

registerAgent({
  slug: "agent-08-email-scanner",
  displayName: "Agent 08 - Email Scanner",
  description:
    "Scans Missive team_inbox for sent messages whose sender email matches a supplier we have outreach to. Flags replies on draft_references + leads. Reads Missive only; never sends.",
  async run(ctx) {
    if (!missivePollingEnabled()) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("Skipped: Missive polling disabled (Tenkara cutover). Inbound replies are handled by the Tenkara message.received webhook.");
      return;
    }
    if (!process.env.MISSIVE_API_TOKEN) {
      await ctx.log("MISSIVE_API_TOKEN not configured", { level: "error", step: "config" });
      ctx.setStatus("failure");
      ctx.setSummary("MISSIVE_API_TOKEN missing.");
      return;
    }
    const admin = createAdminClient();
    const teamId = MISSIVE_TEAM_ID;

    // 1. Load cursor.
    const cursor = await loadCursor(admin, ctx.agentId, teamId);
    await ctx.log(`Cursor: scanning conversations newer than ${new Date(cursor * 1000).toISOString()}`, {
      step: "cursor",
      data: { cursor_unix: cursor },
    });

    // 2. Build outreach_emails map. Pull every draft_references row that's
    //    still in-flight — staged, reviewed, or sent (a reply on a sent draft
    //    is the most interesting case). We pull subject so we can echo what
    //    the original outreach was about in the log.
    const { data: refs, error: refsErr } = await admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, metadata, status, subject, thread_id, assigned_operator")
      .neq("status", "discarded");
    if (refsErr) {
      await ctx.log(`draft_references pull failed: ${refsErr.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${refsErr.message}`);
      return;
    }

    // Build (lower(email), org_id) → rows. We need the recipient email each
    // draft was sent to. Agent 04 stored it on to_fields when creating the
    // draft, but Missive's draft response doesn't echo to_fields back. So we
    // join via leads_in_flight.payload.supplier_contact_email through
    // metadata.lead_id (set by Agent 04). For Agent 02-staged drafts, we look
    // up by supplier_id → Tenkara suppliers (skip in v1; only handle Agent 04
    // drafts so the link is deterministic).
    const leadIds = (refs ?? [])
      .map((r) => (r.metadata as any)?.lead_id)
      .filter((x): x is string => typeof x === "string");
    let leadEmailById = new Map<string, { email: string; orgId: string | null }>();
    if (leadIds.length) {
      const { data: leadRows } = await admin
        .from("leads_in_flight")
        .select("id, org_id, payload")
        .in("id", leadIds);
      for (const lr of (leadRows ?? []) as any[]) {
        const email = (lr.payload?.supplier_contact_email ?? "").toString().trim().toLowerCase();
        if (email) leadEmailById.set(lr.id, { email, orgId: lr.org_id });
      }
    }

    // Watch maps. A supplier reply is matched three ways, in order:
    //   1. exact sender email,
    //   2. sender domain (the reply came from a different person at the same
    //      company — e.g. andre@acme vs the sales@acme we wrote to),
    //   3. the conversation thread our draft created (reply in-thread, from any
    //      address). Thread match is the most reliable and is address-agnostic.
    const outreachByEmail = new Map<string, DraftRefRow[]>();
    const outreachByDomain = new Map<string, DraftRefRow[]>();
    const outreachByThread = new Map<string, DraftRefRow[]>();
    const FREE_EMAIL_DOMAINS = new Set([
      "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
      "icloud.com", "me.com", "proton.me", "protonmail.com", "live.com", "msn.com",
    ]);
    const pushTo = (map: Map<string, DraftRefRow[]>, key: string, row: DraftRefRow) => {
      const arr = map.get(key) ?? [];
      arr.push(row);
      map.set(key, arr);
    };
    for (const r of (refs ?? []) as any[]) {
      const row: DraftRefRow = {
        id: r.id,
        org_id: r.org_id,
        supplier_id: r.supplier_id,
        material_id: r.material_id,
        metadata: r.metadata ?? {},
        status: r.status,
        subject: r.subject ?? null,
        assigned_operator: r.assigned_operator ?? null,
      };
      // Email (and domain) keys. Agent 04 (lead) drafts resolve the email via
      // leads_in_flight; Agent 02 (revalidation) drafts stamp it on metadata.
      const leadId = (r.metadata as any)?.lead_id as string | undefined;
      const metaEmail = (r.metadata as any)?.supplier_contact_email;
      const ev = leadId
        ? leadEmailById.get(leadId)
        : (metaEmail ? { email: String(metaEmail).trim().toLowerCase(), orgId: r.org_id ?? null } : null);
      if (ev?.email) {
        pushTo(outreachByEmail, ev.email, row);
        const dom = ev.email.split("@")[1];
        if (dom && !FREE_EMAIL_DOMAINS.has(dom)) pushTo(outreachByDomain, dom, row);
      }
      // Thread key — match an in-thread reply regardless of sender address.
      if (r.thread_id) pushTo(outreachByThread, String(r.thread_id), row);
    }

    await ctx.log(`Watching ${outreachByEmail.size} emails / ${outreachByDomain.size} domains / ${outreachByThread.size} threads across ${refs?.length ?? 0} drafts`, {
      step: "watchlist",
      data: { emails: outreachByEmail.size, domains: outreachByDomain.size, threads: outreachByThread.size, refs: refs?.length ?? 0 },
    });

    if (outreachByEmail.size === 0 && outreachByThread.size === 0 && outreachByDomain.size === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No outreach to watch for replies yet.");
      // Still save cursor so the first real scan has a clean baseline.
      await saveCursor(admin, ctx.agentId, teamId, Math.floor(Date.now() / 1000));
      return;
    }

    // 3. Pull conversations across every reply-scan inbox. Missive routes a
    //    supplier reply into a stage-based teamspace (1 Inquiries, 2 Quotes, …),
    //    not the sandbox the draft was staged in, so we scan all of them and
    //    dedup by conversation id. Matching is by sender email, so cross-client
    //    threads in shared inboxes are ignored automatically.
    const scanTeamIds = MISSIVE_REPLY_SCAN_TEAM_IDS.length ? MISSIVE_REPLY_SCAN_TEAM_IDS : [teamId];
    const convById = new Map<string, Awaited<ReturnType<typeof listTeamConversations>>[number]>();
    let listErrors = 0;
    for (const tid of scanTeamIds) {
      try {
        const cs = await listTeamConversations(tid, MAX_CONVERSATIONS_PER_RUN);
        for (const c of cs) {
          const prev = convById.get(c.id);
          if (!prev || c.last_activity_at > prev.last_activity_at) convById.set(c.id, c);
        }
      } catch (e: any) {
        listErrors++;
        await ctx.log(`Missive list failed for inbox ${tid}: ${e.message}`, { level: "warn", step: "missive" });
      }
    }
    if (listErrors === scanTeamIds.length) {
      await ctx.log(`Missive list failed for all ${scanTeamIds.length} inboxes`, { level: "error", step: "missive" });
      ctx.setStatus("failure");
      ctx.setSummary("Missive read failed for all reply-scan inboxes.");
      return;
    }
    const conversations = Array.from(convById.values());
    const fresh = conversations.filter((c) => c.last_activity_at > cursor);
    await ctx.log(
      `Pulled ${conversations.length} conversations across ${scanTeamIds.length} inboxes (${fresh.length} newer than cursor)`,
      { step: "list", data: { total: conversations.length, fresh: fresh.length, inboxes: scanTeamIds.length } }
    );

    // 4. Scan fresh conversations for supplier-sent messages.
    let repliesDetected = 0;
    let repliesDrafted = 0;
    let draftErrors = 0;
    let messagesScanned = 0;
    let conversationErrors = 0;
    let stagedQuotesWritten = 0;
    let attachmentsParsed = 0;
    let maxActivityAt = cursor;
    const matchedDraftIds = new Set<string>();
    const attachmentParsedMessageIds = new Set<string>();
    const canParseAttachments = !!process.env.ANTHROPIC_API_KEY;
    const orgNameById = new Map<string, string>();
    // Agent 15 (Reply Manager) now owns drafting responses (with classification
    // + the email workflow). Agent 08 only detects + parses pricing. Set
    // EMAIL_SCANNER_DRAFT_REPLIES=true to fall back to 08's generic reply draft.
    const canDraftReplies = !!process.env.ANTHROPIC_API_KEY && process.env.EMAIL_SCANNER_DRAFT_REPLIES === "true";

    for (const conv of fresh) {
      if (conv.last_activity_at > maxActivityAt) maxActivityAt = conv.last_activity_at;
      let msgs;
      try {
        msgs = await getConversationMessages(conv.id, 10);
      } catch (e: any) {
        conversationErrors++;
        await ctx.log(`Missive get messages failed for ${conv.id}: ${e.message}`, {
          level: "warn",
          step: "messages",
          data: { conversation_id: conv.id },
        });
        continue;
      }

      for (const m of msgs) {
        messagesScanned++;
        if (m.draft) continue;
        if (!m.created_at || m.created_at <= cursor) continue;
        const sender = m.from_field?.address?.toLowerCase();
        if (!sender) continue;
        if (OUR_SENDER_ADDRESSES.has(sender)) continue; // our own outbound, not a reply
        // Match by email → domain → thread (most permissive last).
        let matches = outreachByEmail.get(sender);
        if (!matches || !matches.length) {
          const dom = sender.split("@")[1];
          if (dom) matches = outreachByDomain.get(dom);
        }
        if (!matches || !matches.length) {
          matches = outreachByThread.get(conv.id);
        }
        if (!matches || !matches.length) continue;

        // Parse any pricing attachments on this supplier message into
        // staged_quotes for ops review. Done once per message; uses the first
        // matched draft's org/supplier/material as context.
        if (canParseAttachments && m.attachments?.length && !attachmentParsedMessageIds.has(m.id)) {
          attachmentParsedMessageIds.add(m.id);
          try {
            const ctxRef = matches[0];
            const parsed = await parseMessageAttachments(m.attachments);
            const staged: StagedQuoteInput[] = [];
            for (const { attachment, quotes } of parsed) {
              attachmentsParsed++;
              for (const q of quotes) {
                staged.push({
                  orgId: ctxRef.org_id,
                  runId: ctx.runId,
                  source: "attachment",
                  sourceConversationId: conv.id,
                  sourceMessageId: m.id,
                  sourceAttachmentName: attachment.filename,
                  sourceAttachmentUrl: attachment.url,
                  supplierId: ctxRef.supplier_id,
                  supplierName: q.supplier_name,
                  materialId: ctxRef.material_id,
                  materialName: q.material_name,
                  price: q.price,
                  caseSize: q.case_size,
                  unitOfMeasurement: q.unit_of_measurement,
                  currency: q.currency,
                  grade: (q as any).grade ?? null,
                  leadTimeDays: q.lead_time_days ?? null,
                  leadTimeText: q.lead_time_text ?? null,
                  moqQuantity: q.moq_quantity ?? null,
                  moqUnit: q.moq_unit ?? null,
                  paymentTerms: q.payment_terms ?? null,
                  confidence: q.confidence,
                  extractionNotes: q.notes,
                  rawExtract: q as any,
                });
              }
            }
            if (staged.length) {
              const res = await insertStagedQuotes(admin, staged);
              stagedQuotesWritten += res.inserted;
              await ctx.log(
                `Staged ${res.inserted} quote line${res.inserted === 1 ? "" : "s"} from ${parsed.length} attachment(s) on ${sender}` +
                  (res.skippedDuplicates ? ` (${res.skippedDuplicates} dup skipped)` : ""),
                { step: "attachment_quotes", data: { message_id: m.id, inserted: res.inserted } }
              );
            }
          } catch (e: any) {
            await ctx.log(`Attachment parse failed for message ${m.id}: ${e?.message ?? e}`, {
              level: "warn",
              step: "attachment_quotes",
            });
          }
        }

        // Reply (or fresh inbound) from a supplier we have outreach to.
        for (const ref of matches) {
          if (matchedDraftIds.has(ref.id)) continue; // already stamped this run
          matchedDraftIds.add(ref.id);

          const newMetadata = {
            ...(ref.metadata ?? {}),
            // Advance the pipeline board status. Agent 15 (Reply Manager) takes
            // it from here unless it's already further along.
            flow_status: ["responded", "price_captured", "finalized", "closed_declined"].includes((ref.metadata as any)?.flow_status)
              ? (ref.metadata as any).flow_status
              : "reply_received",
            reply_detected: {
              detected_at: new Date().toISOString(),
              detected_by_run_id: ctx.runId,
              reply_message_id: m.id,
              reply_conversation_id: conv.id,
              reply_sender_email: sender,
              reply_sender_name: m.from_field?.name ?? null,
              reply_subject: m.subject ?? conv.latest_message_subject ?? null,
              reply_unix_at: m.created_at,
              detection_mode:
                conv.id === (ref.metadata as any)?.missive_draft_link?.split("/conversations/")[1]?.split("/")[0]
                  ? "same_thread"
                  : "fresh_thread",
            },
          };
          const { error: drErr } = await admin
            .from("draft_references")
            .update({ metadata: newMetadata })
            .eq("id", ref.id);
          if (drErr) {
            await ctx.log(`draft_references update failed for ${ref.id}: ${drErr.message}`, {
              level: "error",
              step: "stamp",
            });
            continue;
          }

          // Also stamp the lead so /work/leads UI can show "supplier replied".
          const leadId = (ref.metadata as any)?.lead_id as string | undefined;
          let leadRow: any = null;
          if (leadId) {
            const { data } = await admin
              .from("leads_in_flight")
              .select("payload, supplier_name, material_name")
              .eq("id", leadId)
              .maybeSingle();
            leadRow = data;
            const newPayload = {
              ...((leadRow?.payload as any) ?? {}),
              supplier_reply: {
                replied_at: new Date(m.created_at * 1000).toISOString(),
                reply_message_id: m.id,
                reply_conversation_id: conv.id,
                detected_by_run_id: ctx.runId,
              },
            };
            await admin.from("leads_in_flight").update({ payload: newPayload }).eq("id", leadId);
          }
          repliesDetected++;
          await ctx.log(`Reply detected: ${sender} → draft ${ref.id} (conv ${conv.id})`, {
            step: "reply",
            data: { draft_id: ref.id, conversation_id: conv.id, sender, lead_id: leadId ?? null },
          });

          // Draft a response (Agent 04 building block) — operator reviews & sends.
          // Dedup: skip if we already drafted a reply for this draft_reference.
          const alreadyDrafted = !!(ref.metadata as any)?.reply_draft;
          if (canDraftReplies && !alreadyDrafted) {
            try {
              let orgName = "the client";
              if (ref.org_id) {
                if (!orgNameById.has(ref.org_id)) {
                  const { data: o } = await admin.from("orgs").select("name").eq("id", ref.org_id).maybeSingle();
                  orgNameById.set(ref.org_id, o?.name ?? "the client");
                }
                orgName = orgNameById.get(ref.org_id)!;
              }
              const mode = ((ref.metadata as any)?.outreach_mode === "ghost" ? "ghost" : "active") as "active" | "ghost";
              const reply = await composeReply({
                mode,
                clientOrgName: orgName,
                ghostBrand: (ref.metadata as any)?.ghost_brand ?? undefined,
                supplierName: leadRow?.supplier_name ?? null,
                supplierContactName: (leadRow?.payload as any)?.supplier_contact_name ?? m.from_field?.name ?? null,
                materialName: leadRow?.material_name ?? null,
                originalSubject: ref.subject,
                theirSubject: m.subject ?? conv.latest_message_subject ?? null,
                theirPreview: m.preview ?? null,
              });
              const staged = await stageDraft({
                admin,
                agentId: ctx.agentId,
                runId: ctx.runId,
                orgId: ref.org_id,
                supplierId: ref.supplier_id,
                materialId: ref.material_id,
                to: { name: m.from_field?.name ?? null, address: sender },
                subject: reply.subject,
                body: reply.body,
                assignedOperator: ref.assigned_operator,
                metadata: {
                  outreach_mode: mode,
                  ghost_brand: (ref.metadata as any)?.ghost_brand ?? null,
                  draft_kind: "inbound_reply",
                  in_reply_to_draft_ref: ref.id,
                  reply_to_conversation_id: conv.id,
                  lead_id: leadId ?? null,
                },
              });
              if (staged.ok) {
                repliesDrafted++;
                await admin
                  .from("draft_references")
                  .update({
                    metadata: {
                      ...newMetadata,
                      reply_draft: {
                        draft_ref_id: staged.draftRefId,
                        staged_at: new Date().toISOString(),
                        conversation_id: staged.conversationId,
                      },
                    },
                  })
                  .eq("id", ref.id);
                await ctx.log(`Drafted reply for ${sender} (draft_ref ${staged.draftRefId})`, {
                  step: "reply_draft",
                  data: { in_reply_to: ref.id, draft_ref_id: staged.draftRefId },
                });
              } else {
                draftErrors++;
                await ctx.log(`Reply draft staging failed for ${ref.id}: ${staged.error}`, { level: "warn", step: "reply_draft" });
              }
            } catch (e: any) {
              draftErrors++;
              await ctx.log(`Reply compose failed for ${ref.id}: ${e?.message ?? e}`, { level: "warn", step: "reply_draft" });
            }
          }
        }
      }
    }

    // 5. Save cursor (advance to max activity seen, even if no replies).
    await saveCursor(admin, ctx.agentId, teamId, maxActivityAt);

    ctx.setItemsProcessed(repliesDetected);
    ctx.setStatus(conversationErrors > 0 && repliesDetected === 0 ? "partial" : "success");
    ctx.setSummary(
      `Scanned ${fresh.length} fresh conversations · ${messagesScanned} messages · ${repliesDetected} supplier repl${repliesDetected === 1 ? "y" : "ies"} detected · ${repliesDrafted} reply draft${repliesDrafted === 1 ? "" : "s"} staged${stagedQuotesWritten ? ` · ${stagedQuotesWritten} attachment quote${stagedQuotesWritten === 1 ? "" : "s"} staged (${attachmentsParsed} file${attachmentsParsed === 1 ? "" : "s"})` : ""}${draftErrors ? ` · ${draftErrors} draft errors` : ""}${conversationErrors ? ` · ${conversationErrors} conv errors` : ""}`
    );
  },
});
