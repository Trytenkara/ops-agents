import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTenkaraConversationDetails, type TenkaraMessage } from "@/lib/tenkara";
import { parseTaggedRecipient } from "@/lib/inquiry-reply-tag";
import { onlyOrgNames, onlyOrgLabel } from "@/lib/org-scope";
import Anthropic from "@anthropic-ai/sdk";

// Agent 13 - Inbox Context.
// For every supplier we have actually exchanged email with, records when we last
// reached out, when (if) they last replied, the resulting thread state, and a
// short summary / open ask. Agent 02 looks this up by supplier email before
// drafting, and switches to a follow-up tone when a thread already exists.
//
// Thread list comes from draft_references (OA), which holds the Tenkara
// conversation id for every draft we have ever staged. Tenkara has no
// list-conversations endpoint, so this is the only way to enumerate threads.
// Message history comes from GET /api/external/conversations/{id}.
//
// A staged draft that nobody ever sent has an empty message list. Those threads
// are skipped rather than recorded: writing a row for one would tell Agent 02 a
// conversation exists and push it into follow-up mode on an email the supplier
// never received. No row means "cold", which is the truth.
//
// Read-only on Tenkara; the only writes are upserts into supplier_email_context.

const STALE_DAYS = 21;
// How far back to consider a thread worth refreshing context for.
const LOOKBACK_DAYS = 90;
// Each thread costs one Tenkara API call, so cap the fan-out per run. Threads are
// walked best-first (see rankThreads), so the cap drops cold unsent drafts, which
// are the ones that would have yielded nothing anyway.
const MAX_CONVERSATIONS = 200;
// Cap LLM summaries so a big inbox can't blow the run budget. Threads beyond
// this still get a heuristic summary from the latest message body.
const MAX_LLM_SUMMARIES = 40;
// Messages and characters fed to the summarizer per thread.
const TRANSCRIPT_MESSAGES = 4;
const TRANSCRIPT_CHARS_PER_MESSAGE = 1200;

// Optional scope: reuse the same flag Agent 02 uses so a single-org run only
// builds context for that org's suppliers.
const ONLY_ORGS = onlyOrgNames();
const ONLY_ORG_LABEL = onlyOrgLabel();

// Short (~300-token) inbox summaries — squarely a Haiku-tier task. Bump to
// claude-sonnet-5 only if summary quality feeding downstream agents regresses.
const SUMMARY_MODEL = "claude-haiku-4-5";

interface ThreadRef {
  thread_id: string;
  supplier_email: string;
  supplier_name: string | null;
  supplier_id: string | null;
  org_id: string | null;
  // A reply we have already processed, or a no-reply nudge, both prove the
  // outreach was actually sent — so the conversation has messages to read.
  hasKnownTraffic: boolean;
  isInternalOrg: boolean;
  createdAt: string;
}

interface Accum {
  supplier_email: string;
  supplier_name: string | null;
  supplier_id: string | null;
  org_id: string | null;
  lastOutboundAt: number | null; // epoch ms
  lastInboundAt: number | null;
  messageCount: number;
  latestConversationId: string | null;
  latestInbound: string | null;
  latestOutbound: string | null;
  transcript: { who: "us" | "them"; at: number; text: string }[];
}

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
const EMAIL_RE = /^[^@\s;,]+@[^@\s;,]+\.[^@\s;,]+$/;

function messageText(m: TenkaraMessage): string {
  const body = (m.body_text ?? "").trim();
  if (body) return body;
  return (m.subject ?? "").trim();
}

// The address a draft went to. Cold outbound and no-reply nudges record it
// directly; the inbound-reply path only leaves the sender on the allowlist.
function recipientOf(metadata: any): string | null {
  const direct = lc(metadata?.supplier_contact_email);
  if (EMAIL_RE.test(direct)) return direct;
  const approved = Array.isArray(metadata?.approved_contacts) ? metadata.approved_contacts : [];
  for (const a of approved) {
    const em = lc(a);
    if (EMAIL_RE.test(em)) return em;
  }
  return null;
}

async function summarize(
  client: Anthropic,
  supplierName: string,
  transcript: string
): Promise<{ summary: string; open_ask: string | null }> {
  const res = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 300,
    system:
      "You summarize a short email thread between our procurement team and a supplier. " +
      "Respond with a JSON object: {\"summary\": \"<=2 sentences of what's happened\", " +
      "\"open_ask\": \"<the single thing still owed by either side, or null>\"}. " +
      "Be factual, no fluff, no greetings.",
    messages: [
      { role: "user", content: `Supplier: ${supplierName}\n\nThread (oldest first):\n${transcript}` },
    ],
  });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return { summary: text.slice(0, 400), open_ask: null };
  try {
    const parsed = JSON.parse(text.slice(s, e + 1));
    return {
      summary: String(parsed.summary ?? "").slice(0, 800),
      open_ask: parsed.open_ask ? String(parsed.open_ask).slice(0, 400) : null,
    };
  } catch {
    return { summary: text.slice(0, 400), open_ask: null };
  }
}

// Known-traffic threads first (they are the only ones guaranteed to have
// messages), then real clients ahead of internal test orgs per fleet priority,
// then newest. The cap therefore truncates the least useful tail.
function rankThreads(a: ThreadRef, b: ThreadRef): number {
  if (a.hasKnownTraffic !== b.hasKnownTraffic) return a.hasKnownTraffic ? -1 : 1;
  if (a.isInternalOrg !== b.isInternalOrg) return a.isInternalOrg ? 1 : -1;
  return b.createdAt.localeCompare(a.createdAt);
}

registerAgent({
  slug: "agent-13-inbox-context",
  displayName: "Agent 13 - Inbox Context",
  description:
    "Walks the Tenkara threads we have staged drafts into and builds a per-supplier email-context row (last outbound/inbound, thread state, summary, open ask) so Agent 02 reaches out with the right tone. Read-only on Tenkara; writes supplier_email_context in OA only.",
  async run(ctx) {
    const admin = createAdminClient();

    // 1. Our own inbox addresses, so a message can be classified by sender.
    //    Anything not from us is the supplier, which handles the common case of a
    //    colleague replying from an address we never wrote to.
    const { data: orgRows, error: orgErr } = await admin
      .from("orgs")
      .select("id, name, is_internal, tenkara_org_id, tenkara_email_address");
    if (orgErr) {
      await ctx.log(`orgs read failed: ${orgErr.message}`, { level: "error", step: "orgs" });
      ctx.setStatus("failure");
      ctx.setSummary(`Could not load orgs: ${orgErr.message}`);
      return;
    }
    const ourAddresses = new Set<string>();
    const orgById = new Map<string, { name: string; isInternal: boolean; tenkaraOrgId: string | null }>();
    for (const o of orgRows ?? []) {
      const row = o as any;
      orgById.set(row.id, {
        name: row.name,
        isInternal: !!row.is_internal,
        tenkaraOrgId: row.tenkara_org_id ?? null,
      });
      const addr = lc(row.tenkara_email_address);
      if (addr) ourAddresses.add(parseTaggedRecipient(addr).base ?? addr);
    }
    if (ourAddresses.size === 0) {
      await ctx.log("No org has a Tenkara inbox address — cannot tell inbound from outbound.", {
        level: "error",
        step: "orgs",
      });
      ctx.setStatus("failure");
      ctx.setSummary("No Tenkara inbox addresses configured.");
      return;
    }

    // 2. Every Tenkara thread we have staged a draft into, most recent first.
    //    supplier_id is NOT required: Agents 04/08/15 leave it null (only Agent 02
    //    sets it), and Agent 02 keys this table on the email anyway.
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
    const { data: draftRows, error: draftErr } = await admin
      .from("draft_references")
      .select("thread_id, supplier_id, org_id, metadata, created_at")
      .eq("email_client", "rod_app")
      .not("thread_id", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (draftErr) {
      await ctx.log(`draft_references read failed: ${draftErr.message}`, { level: "error", step: "threads" });
      ctx.setStatus("failure");
      ctx.setSummary(`Could not list threads: ${draftErr.message}`);
      return;
    }

    // Collapse to one entry per thread. Prefer a company name over the personal
    // name an inbound reply carries, and remember whether any draft on the thread
    // proves the outreach was really sent.
    const byThread = new Map<string, ThreadRef>();
    let noRecipient = 0;
    let outOfScope = 0;
    for (const r of draftRows ?? []) {
      const row = r as any;
      const tid = row.thread_id as string;
      const email = recipientOf(row.metadata);
      if (!email) {
        if (!byThread.has(tid)) noRecipient++;
        continue;
      }
      const org = row.org_id ? orgById.get(row.org_id) : undefined;
      if (ONLY_ORGS.length && !(org && ONLY_ORGS.includes(org.name))) {
        outOfScope++;
        continue;
      }
      const kind = row.metadata?.draft_kind ?? null;
      const traffic = kind === "inbound_reply" || kind === "no_reply_followup";
      const existing = byThread.get(tid);
      if (!existing) {
        byThread.set(tid, {
          thread_id: tid,
          supplier_email: email,
          supplier_name: row.metadata?.supplier_name ?? null,
          supplier_id: row.supplier_id ?? null,
          org_id: row.org_id ?? null,
          hasKnownTraffic: traffic,
          isInternalOrg: org?.isInternal ?? false,
          createdAt: row.created_at,
        });
        continue;
      }
      existing.hasKnownTraffic ||= traffic;
      existing.supplier_id ??= row.supplier_id ?? null;
      // Rows arrive newest-first, so an older cold_outbound name overwrites the
      // personal name a later inbound_reply recorded.
      if (kind === "cold_outbound" && row.metadata?.supplier_name) {
        existing.supplier_name = row.metadata.supplier_name;
      }
    }

    const ranked = [...byThread.values()].sort(rankThreads);
    const budgeted = ranked.slice(0, MAX_CONVERSATIONS);
    const knownTraffic = ranked.filter((t) => t.hasKnownTraffic).length;
    await ctx.log(
      `${ranked.length} threads in the last ${LOOKBACK_DAYS}d (${knownTraffic} with known traffic); walking ${budgeted.length}` +
        (ranked.length > budgeted.length ? `, skipping ${ranked.length - budgeted.length} colder threads` : ""),
      {
        step: "threads",
        data: {
          threads: ranked.length,
          knownTraffic,
          walking: budgeted.length,
          droppedByCap: ranked.length - budgeted.length,
          noRecipient,
          outOfScope,
          scope: ONLY_ORG_LABEL,
        },
      }
    );
    if (budgeted.length === 0) {
      ctx.setStatus("success");
      ctx.setSummary("No Tenkara threads to build context from.");
      ctx.setItemsProcessed(0);
      return;
    }

    // 3. Walk each thread's message history, accumulating per supplier address.
    const accum = new Map<string, Accum>();
    let threadMisses = 0;
    let emptyThreads = 0;
    for (const t of budgeted) {
      const details = await getTenkaraConversationDetails(t.thread_id);
      if (!details.found) {
        threadMisses++;
        continue;
      }

      const usable = details.messages
        .map((m) => {
          if (!m.sent_at) return null;
          const at = Date.parse(m.sent_at);
          if (Number.isNaN(at)) return null;
          const text = messageText(m);
          if (!text) return null;
          const sender = parseTaggedRecipient(lc(m.from_email)).base ?? lc(m.from_email);
          return { at, text, inbound: !ourAddresses.has(sender) };
        })
        .filter((m): m is { at: number; text: string; inbound: boolean } => m !== null);

      // Staged but never sent. No conversation happened, so record nothing.
      if (usable.length === 0) {
        emptyThreads++;
        continue;
      }

      let a = accum.get(t.supplier_email);
      if (!a) {
        a = {
          supplier_email: t.supplier_email,
          supplier_name: t.supplier_name,
          supplier_id: t.supplier_id,
          org_id: t.org_id,
          lastOutboundAt: null,
          lastInboundAt: null,
          messageCount: 0,
          latestConversationId: t.thread_id,
          latestInbound: null,
          latestOutbound: null,
          transcript: [],
        };
        accum.set(t.supplier_email, a);
      }

      for (const m of usable) {
        a.messageCount += 1;
        a.transcript.push({ who: m.inbound ? "them" : "us", at: m.at, text: m.text });
        if (m.inbound) {
          if (!a.lastInboundAt || m.at > a.lastInboundAt) {
            a.lastInboundAt = m.at;
            a.latestInbound = m.text;
            a.latestConversationId = t.thread_id;
          }
        } else if (!a.lastOutboundAt || m.at > a.lastOutboundAt) {
          a.lastOutboundAt = m.at;
          a.latestOutbound = m.text;
        }
      }
    }

    if (accum.size === 0) {
      await ctx.log("No thread had any sent or received message — nothing to upsert.", {
        step: "done",
        data: { threadMisses, emptyThreads },
      });
      ctx.setStatus(threadMisses > 0 ? "partial" : "success");
      ctx.setSummary(
        `Walked ${budgeted.length} threads; ${emptyThreads} staged-but-unsent, ${threadMisses} unreadable. No context to write.`
      );
      ctx.setItemsProcessed(0);
      return;
    }

    // 4. Derive state, summarize, upsert.
    const staleCutoff = Date.now() - STALE_DAYS * 86400_000;
    const client = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;
    let summariesDone = 0;
    let upserted = 0;
    const stateCounts: Record<string, number> = {};

    for (const [, a] of accum) {
      const lastMessageAt = Math.max(a.lastInboundAt ?? 0, a.lastOutboundAt ?? 0);
      let thread_state: string;
      if (lastMessageAt < staleCutoff) {
        thread_state = "stale";
      } else if (a.lastInboundAt && (!a.lastOutboundAt || a.lastInboundAt >= a.lastOutboundAt)) {
        thread_state = "they_replied";
      } else {
        thread_state = "awaiting_their_reply";
      }
      stateCounts[thread_state] = (stateCounts[thread_state] ?? 0) + 1;

      // Summary: LLM for replied threads (most valuable), capped; else heuristic.
      let summary: string | null = (a.latestInbound ?? a.latestOutbound ?? "").slice(0, 800) || null;
      let open_ask: string | null = null;
      if (client && a.lastInboundAt && summariesDone < MAX_LLM_SUMMARIES) {
        const transcript = a.transcript
          .sort((x, y) => x.at - y.at)
          .slice(-TRANSCRIPT_MESSAGES)
          .map((m) => `${m.who === "us" ? "Us" : a.supplier_name ?? "Supplier"}: ${m.text.slice(0, TRANSCRIPT_CHARS_PER_MESSAGE)}`)
          .join("\n\n");
        if (transcript) {
          try {
            const r = await summarize(client, a.supplier_name ?? a.supplier_email, transcript);
            summary = r.summary || summary;
            open_ask = r.open_ask;
            summariesDone += 1;
          } catch (e: any) {
            await ctx.log(`Summary failed for ${a.supplier_email}: ${e.message}`, {
              level: "warn",
              step: "summarize",
            });
          }
        }
      }

      const { error } = await admin.from("supplier_email_context").upsert(
        {
          org_id: a.org_id,
          run_id: ctx.runId,
          tenkara_org_id: a.org_id ? orgById.get(a.org_id)?.tenkaraOrgId ?? null : null,
          supplier_id: a.supplier_id,
          supplier_name: a.supplier_name,
          supplier_email: a.supplier_email,
          last_outbound_at: iso(a.lastOutboundAt),
          last_inbound_at: iso(a.lastInboundAt),
          last_message_at: iso(lastMessageAt),
          message_count: a.messageCount,
          latest_conversation_id: a.latestConversationId,
          thread_state,
          summary,
          open_ask,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "supplier_email" }
      );
      if (error) {
        await ctx.log(`Upsert failed for ${a.supplier_email}: ${error.message}`, {
          level: "error",
          step: "upsert",
        });
      } else {
        upserted += 1;
      }
    }

    await ctx.log(
      `Upserted ${upserted} supplier-context rows (${Object.entries(stateCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}); ${summariesDone} LLM summaries; ${emptyThreads} threads staged-but-unsent`,
      { step: "done", data: { upserted, stateCounts, summaries: summariesDone, threadMisses, emptyThreads } }
    );
    ctx.setStatus(threadMisses > 0 ? "partial" : "success");
    ctx.setItemsProcessed(upserted);
    ctx.setSummary(
      `Built context for ${upserted} suppliers (${Object.entries(stateCounts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}); ${emptyThreads} threads staged but never sent.`
    );
  },
});
