import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { listLabelConversations, getConversationMessages } from "@/lib/missive";
import { MISSIVE_BOBBER_LABS_LABEL_ID } from "../quote-revalidation/config";
import Anthropic from "@anthropic-ai/sdk";

// Agent 13 - Inbox Context.
// Reads the Missive "Bobber Labs" shared label and, for every supplier we recognize, records
// when we last reached out, when (if) they last replied, the resulting thread
// state, and a short summary / open ask. Agent 02 reads supplier_email_context
// before drafting so revalidation uses a follow-up tone when a thread exists.
//
// Read-only on Missive + Tenkara; the only writes are upserts into
// supplier_email_context (OA).

const STALE_DAYS = 21;
const MAX_CONVERSATIONS = 200;
const MESSAGES_PER_CONVERSATION = 10;
// Cap LLM summaries so a big inbox can't blow the run budget. Threads beyond
// this still get a heuristic summary from the latest message preview.
const MAX_LLM_SUMMARIES = 40;

// Optional scope: reuse the same flag Agent 02 uses so a Bobber-Labs-only run
// only builds context for Bobber Labs suppliers.
const ONLY_ORG = process.env.QR_ONLY_ORG?.trim() || null;

const SUMMARY_MODEL = "claude-opus-4-5";

interface SupplierRef {
  supplier_id: string;
  supplier_name: string;
  tenkara_org_id: string;
  org_name: string;
}

interface ThreadAccum {
  ref: SupplierRef;
  lastOutboundAt: number | null; // unix seconds (message we sent)
  lastInboundAt: number | null; // unix seconds (message from the supplier)
  messageCount: number;
  latestConversationId: string | null;
  latestInboundPreview: string | null;
  latestOutboundPreview: string | null;
}

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const iso = (unix: number | null) => (unix ? new Date(unix * 1000).toISOString() : null);

async function loadSupplierMap(): Promise<Map<string, SupplierRef>> {
  const rows = await tenkaraQuery<{
    supplier_id: string;
    supplier_name: string;
    poc_email: string;
    tenkara_org_id: string;
    org_name: string;
  }>(
    `
    SELECT DISTINCT s.id::text AS supplier_id, s.name AS supplier_name, s.poc_email,
      client_org.id::text AS tenkara_org_id, client_org.name AS org_name
    FROM suppliers s
    JOIN material_quotes mq ON mq.supplier_id = s.id
    JOIN materials m ON m.id = mq.material_id
    JOIN users u ON u.id = m.user_id
    JOIN organizations client_org ON client_org.id = u.organization_id
    WHERE s.poc_email IS NOT NULL AND s.poc_email <> ''
      ${ONLY_ORG ? "AND client_org.name = $1" : ""}
    `,
    ONLY_ORG ? [ONLY_ORG] : []
  );
  const map = new Map<string, SupplierRef>();
  for (const r of rows) {
    const email = lc(r.poc_email);
    // A valid single address only (mirrors the Agent 02 contact filter).
    if (!/^[^@\s;,]+@[^@\s;,]+\.[^@\s;,]+$/.test(email)) continue;
    if (!map.has(email)) {
      map.set(email, {
        supplier_id: r.supplier_id,
        supplier_name: r.supplier_name,
        tenkara_org_id: r.tenkara_org_id,
        org_name: r.org_name,
      });
    }
  }
  return map;
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

registerAgent({
  slug: "agent-13-inbox-context",
  displayName: "Agent 13 - Inbox Context",
  description:
    "Reads the Missive 'Bobber Labs' shared label and builds a per-supplier email-context row (last outbound/inbound, thread state, summary, open ask) so Agent 02 reaches out with the right tone. Read-only on Missive/Tenkara; writes supplier_email_context in OA only.",
  async run(ctx) {
    if (!process.env.MISSIVE_API_TOKEN) {
      ctx.setStatus("failure");
      ctx.setSummary("MISSIVE_API_TOKEN missing.");
      return;
    }
    const admin = createAdminClient();

    // 1. Universe of supplier emails we care about (scoped if ONLY_ORG set).
    let supplierMap: Map<string, SupplierRef>;
    try {
      supplierMap = await loadSupplierMap();
    } catch (e: any) {
      await ctx.log(`Tenkara supplier query failed: ${e.message}`, { level: "error", step: "suppliers" });
      ctx.setStatus("failure");
      ctx.setSummary(`Failed loading suppliers: ${e.message}`);
      return;
    }
    await ctx.log(`Tracking ${supplierMap.size} supplier addresses${ONLY_ORG ? ` for ${ONLY_ORG}` : ""}`, {
      step: "suppliers",
      data: { suppliers: supplierMap.size, scope: ONLY_ORG },
    });
    if (supplierMap.size === 0) {
      ctx.setStatus("success");
      ctx.setSummary("No supplier addresses to track.");
      return;
    }

    // 2. Pull conversations (scoped to the Bobber Labs shared label) and
    //    accumulate per-supplier timelines.
    const labelId = process.env.INBOX_CONTEXT_LABEL_ID?.trim() || MISSIVE_BOBBER_LABS_LABEL_ID;
    let conversations;
    try {
      conversations = await listLabelConversations(labelId, MAX_CONVERSATIONS);
    } catch (e: any) {
      await ctx.log(`Missive list conversations failed: ${e.message}`, { level: "error", step: "missive" });
      ctx.setStatus("failure");
      ctx.setSummary(`Missive read failed: ${e.message}`);
      return;
    }

    // Only bother fetching messages for conversations that involve a tracked
    // supplier address (per external_authors), to keep API calls bounded.
    const relevant = conversations.filter((c) =>
      (c.external_authors ?? []).some((a) => supplierMap.has(lc(a.address)))
    );
    await ctx.log(`Pulled ${conversations.length} conversations; ${relevant.length} involve a tracked supplier`, {
      step: "list",
      data: { total: conversations.length, relevant: relevant.length },
    });

    const accum = new Map<string, ThreadAccum>(); // keyed by supplier_email
    let conversationErrors = 0;
    for (const conv of relevant) {
      let msgs;
      try {
        msgs = await getConversationMessages(conv.id, MESSAGES_PER_CONVERSATION);
      } catch (e: any) {
        conversationErrors++;
        await ctx.log(`Missive get messages failed for ${conv.id}: ${e.message}`, {
          level: "warn",
          step: "messages",
          data: { conversation_id: conv.id },
        });
        continue;
      }

      // Which tracked suppliers are in this conversation (by any participant)?
      const convSuppliers = new Set<string>();
      for (const a of conv.external_authors ?? []) {
        const em = lc(a.address);
        if (supplierMap.has(em)) convSuppliers.add(em);
      }

      for (const m of msgs) {
        if (m.draft) continue; // ignore unsent drafts
        if (!m.created_at) continue;
        const sender = lc(m.from_field?.address);
        const preview = (m.preview ?? m.subject ?? "").toString().slice(0, 500) || null;

        for (const email of convSuppliers) {
          let a = accum.get(email);
          if (!a) {
            a = {
              ref: supplierMap.get(email)!,
              lastOutboundAt: null,
              lastInboundAt: null,
              messageCount: 0,
              latestConversationId: conv.id,
              latestInboundPreview: null,
              latestOutboundPreview: null,
            };
            accum.set(email, a);
          }
          a.messageCount += 1;
          a.latestConversationId = conv.id;
          if (sender === email) {
            // Inbound: the supplier sent this.
            if (!a.lastInboundAt || m.created_at > a.lastInboundAt) {
              a.lastInboundAt = m.created_at;
              a.latestInboundPreview = preview;
            }
          } else {
            // Outbound: anyone-not-the-supplier in a thread with them = us.
            if (!a.lastOutboundAt || m.created_at > a.lastOutboundAt) {
              a.lastOutboundAt = m.created_at;
              a.latestOutboundPreview = preview;
            }
          }
        }
      }
    }

    if (accum.size === 0) {
      await ctx.log("No supplier threads found in the inbox — nothing to upsert.", { step: "done" });
      ctx.setStatus("success");
      ctx.setSummary(`Scanned ${relevant.length} relevant conversations; no supplier threads yet.`);
      ctx.setItemsProcessed(0);
      return;
    }

    // 3. Derive state, summarize, upsert.
    const nowUnix = Math.floor(Date.now() / 1000);
    const staleCutoff = nowUnix - STALE_DAYS * 86400;
    const canSummarize = !!process.env.ANTHROPIC_API_KEY;
    const client = canSummarize ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
    let summariesDone = 0;
    let upserted = 0;
    const stateCounts: Record<string, number> = {};

    // Resolve tenkara_org_id -> OA org_id once.
    const orgIdCache = new Map<string, string | null>();
    async function resolveOrgId(tenkaraOrgId: string): Promise<string | null> {
      if (orgIdCache.has(tenkaraOrgId)) return orgIdCache.get(tenkaraOrgId)!;
      const { data } = await admin.from("orgs").select("id").eq("tenkara_org_id", tenkaraOrgId).maybeSingle();
      const id = (data as any)?.id ?? null;
      orgIdCache.set(tenkaraOrgId, id);
      return id;
    }

    for (const [email, a] of accum) {
      const lastMessageAt = Math.max(a.lastInboundAt ?? 0, a.lastOutboundAt ?? 0) || null;
      let thread_state: string;
      if (lastMessageAt && lastMessageAt < staleCutoff) {
        thread_state = "stale";
      } else if (a.lastInboundAt && (!a.lastOutboundAt || a.lastInboundAt >= a.lastOutboundAt)) {
        thread_state = "they_replied";
      } else if (a.lastOutboundAt) {
        thread_state = "awaiting_their_reply";
      } else {
        thread_state = "they_replied"; // inbound-only edge case
      }
      stateCounts[thread_state] = (stateCounts[thread_state] ?? 0) + 1;

      // Summary: LLM for replied threads (most valuable), capped; else heuristic.
      let summary: string | null =
        a.latestInboundPreview ?? a.latestOutboundPreview ?? null;
      let open_ask: string | null = null;
      if (client && a.lastInboundAt && summariesDone < MAX_LLM_SUMMARIES) {
        const transcript = [
          a.latestOutboundPreview ? `Us: ${a.latestOutboundPreview}` : null,
          a.latestInboundPreview ? `${a.ref.supplier_name}: ${a.latestInboundPreview}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        if (transcript) {
          try {
            const r = await summarize(client, a.ref.supplier_name, transcript);
            summary = r.summary || summary;
            open_ask = r.open_ask;
            summariesDone += 1;
          } catch (e: any) {
            await ctx.log(`Summary failed for ${a.ref.supplier_name}: ${e.message}`, {
              level: "warn",
              step: "summarize",
            });
          }
        }
      }

      const org_id = await resolveOrgId(a.ref.tenkara_org_id);
      const { error } = await admin.from("supplier_email_context").upsert(
        {
          org_id,
          run_id: ctx.runId,
          tenkara_org_id: a.ref.tenkara_org_id,
          supplier_id: a.ref.supplier_id,
          supplier_name: a.ref.supplier_name,
          supplier_email: email,
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
        await ctx.log(`Upsert failed for ${email}: ${error.message}`, { level: "error", step: "upsert" });
      } else {
        upserted += 1;
      }
    }

    await ctx.log(
      `Upserted ${upserted} supplier-context rows (${Object.entries(stateCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}); ${summariesDone} LLM summaries`,
      { step: "done", data: { upserted, stateCounts, summaries: summariesDone, conversationErrors } }
    );
    ctx.setStatus(conversationErrors > 0 ? "partial" : "success");
    ctx.setItemsProcessed(upserted);
    ctx.setSummary(
      `Built context for ${upserted} suppliers (${Object.entries(stateCounts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}).`
    );
  },
});
