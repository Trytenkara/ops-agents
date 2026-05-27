import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { listTeamConversations, getConversationMessages } from "@/lib/missive";
import { MISSIVE_TEAM_ID } from "../quote-revalidation/config";

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
// Safety:
//   - Read-only on Missive (no POSTs, no /drafts calls).
//   - Writes only to OA (draft_references.metadata + leads_in_flight.payload + agent_state).
//   - training_wheels_mode=true on the agent row.
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_CONVERSATIONS_PER_RUN = 50;

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
}

registerAgent({
  slug: "agent-08-email-scanner",
  displayName: "Agent 08 - Email Scanner",
  description:
    "Scans Missive team_inbox for sent messages whose sender email matches a supplier we have outreach to. Flags replies on draft_references + leads. Reads Missive only; never sends.",
  async run(ctx) {
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
      .select("id, org_id, supplier_id, material_id, metadata, status, subject, thread_id")
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

    // Map: lower(email) → DraftRefRow[]
    const outreachByEmail = new Map<string, DraftRefRow[]>();
    for (const r of (refs ?? []) as any[]) {
      const leadId = (r.metadata as any)?.lead_id as string | undefined;
      const ev = leadId ? leadEmailById.get(leadId) : null;
      if (!ev) continue;
      const arr = outreachByEmail.get(ev.email) ?? [];
      arr.push({
        id: r.id,
        org_id: r.org_id,
        supplier_id: r.supplier_id,
        material_id: r.material_id,
        metadata: r.metadata ?? {},
        status: r.status,
      });
      outreachByEmail.set(ev.email, arr);
    }

    await ctx.log(`Watching ${outreachByEmail.size} unique supplier email${outreachByEmail.size === 1 ? "" : "s"} across ${refs?.length ?? 0} drafts`, {
      step: "watchlist",
      data: { emails: outreachByEmail.size, refs: refs?.length ?? 0 },
    });

    if (outreachByEmail.size === 0) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary("No outreach to watch for replies yet.");
      // Still save cursor so the first real scan has a clean baseline.
      await saveCursor(admin, ctx.agentId, teamId, Math.floor(Date.now() / 1000));
      return;
    }

    // 3. Pull conversations.
    let conversations;
    try {
      conversations = await listTeamConversations(teamId, MAX_CONVERSATIONS_PER_RUN);
    } catch (e: any) {
      await ctx.log(`Missive list conversations failed: ${e.message}`, { level: "error", step: "missive" });
      ctx.setStatus("failure");
      ctx.setSummary(`Missive read failed: ${e.message}`);
      return;
    }
    const fresh = conversations.filter((c) => c.last_activity_at > cursor);
    await ctx.log(
      `Pulled ${conversations.length} conversations from team_inbox (${fresh.length} newer than cursor)`,
      { step: "list", data: { total: conversations.length, fresh: fresh.length } }
    );

    // 4. Scan fresh conversations for supplier-sent messages.
    let repliesDetected = 0;
    let messagesScanned = 0;
    let conversationErrors = 0;
    let maxActivityAt = cursor;
    const matchedDraftIds = new Set<string>();

    for (const conv of fresh) {
      if (conv.last_activity_at > maxActivityAt) maxActivityAt = conv.last_activity_at;
      let msgs;
      try {
        msgs = await getConversationMessages(conv.id, 25);
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
        const matches = outreachByEmail.get(sender);
        if (!matches || !matches.length) continue;

        // Reply (or fresh inbound) from a supplier we have outreach to.
        for (const ref of matches) {
          if (matchedDraftIds.has(ref.id)) continue; // already stamped this run
          matchedDraftIds.add(ref.id);

          const newMetadata = {
            ...(ref.metadata ?? {}),
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
          if (leadId) {
            const { data: leadRow } = await admin
              .from("leads_in_flight")
              .select("payload")
              .eq("id", leadId)
              .maybeSingle();
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
        }
      }
    }

    // 5. Save cursor (advance to max activity seen, even if no replies).
    await saveCursor(admin, ctx.agentId, teamId, maxActivityAt);

    ctx.setItemsProcessed(repliesDetected);
    ctx.setStatus(conversationErrors > 0 && repliesDetected === 0 ? "partial" : "success");
    ctx.setSummary(
      `Scanned ${fresh.length} fresh conversations · ${messagesScanned} messages · ${repliesDetected} supplier reply${repliesDetected === 1 ? "" : "ies"} detected${conversationErrors ? ` · ${conversationErrors} conv errors` : ""}`
    );
  },
});
