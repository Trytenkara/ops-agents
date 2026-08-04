import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { tenkaraQuery } from "@/lib/tenkara-readonly";
import { getTenkaraConversationDetails, type TenkaraMessage } from "@/lib/tenkara";
import { onlyOrgNames, onlyOrgLabel } from "@/lib/org-scope";
import Anthropic from "@anthropic-ai/sdk";

// Agent 13 - Inbox Context.
// For every supplier we have emailed, records when we last reached out, when (if)
// they last replied, the resulting thread state, and a short summary / open ask.
// Agent 02 reads supplier_email_context before drafting so revalidation uses a
// follow-up tone when a thread already exists.
//
// Thread list comes from draft_references (OA), which holds the Tenkara
// conversation id for every draft we have ever staged. Tenkara has no
// list-conversations endpoint, so this is the only way to enumerate threads.
// Message history comes from GET /api/external/conversations/{id}.
//
// Read-only on Tenkara; the only writes are upserts into supplier_email_context.

const STALE_DAYS = 21;
// How far back to consider a thread worth refreshing context for.
const LOOKBACK_DAYS = 90;
// Each thread costs one Tenkara API call, so cap the fan-out per run.
const MAX_CONVERSATIONS = 150;
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
  supplier_id: string;
  org_id: string | null;
}

interface SupplierRef {
  supplier_id: string;
  supplier_name: string;
  supplier_email: string;
  tenkara_org_id: string;
  addresses: Set<string>;
}

interface ThreadAccum {
  ref: SupplierRef;
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
    "Walks the Tenkara threads we have staged drafts into and builds a per-supplier email-context row (last outbound/inbound, thread state, summary, open ask) so Agent 02 reaches out with the right tone. Read-only on Tenkara; writes supplier_email_context in OA only.",
  async run(ctx) {
    const admin = createAdminClient();

    // 1. Every Tenkara thread we have staged a draft into, most recent first.
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
    const { data: draftRows, error: draftErr } = await admin
      .from("draft_references")
      .select("thread_id, supplier_id, org_id, created_at")
      .eq("email_client", "rod_app")
      .not("thread_id", "is", null)
      .not("supplier_id", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (draftErr) {
      await ctx.log(`draft_references read failed: ${draftErr.message}`, { level: "error", step: "threads" });
      ctx.setStatus("failure");
      ctx.setSummary(`Could not list threads: ${draftErr.message}`);
      return;
    }

    // Dedupe to one entry per thread, keeping the newest draft's supplier/org.
    const threads: ThreadRef[] = [];
    const seenThreads = new Set<string>();
    for (const r of draftRows ?? []) {
      const tid = (r as any).thread_id as string;
      if (seenThreads.has(tid)) continue;
      seenThreads.add(tid);
      threads.push({ thread_id: tid, supplier_id: (r as any).supplier_id, org_id: (r as any).org_id ?? null });
    }
    const budgeted = threads.slice(0, MAX_CONVERSATIONS);
    await ctx.log(
      `${threads.length} Tenkara threads in the last ${LOOKBACK_DAYS}d; walking ${budgeted.length}`,
      { step: "threads", data: { threads: threads.length, walking: budgeted.length } }
    );
    if (budgeted.length === 0) {
      ctx.setStatus("success");
      ctx.setSummary("No Tenkara threads to build context from.");
      ctx.setItemsProcessed(0);
      return;
    }

    // 2. Supplier identity for those threads (name, primary address, client org).
    const supplierIds = [...new Set(budgeted.map((t) => t.supplier_id))];
    let supplierRows: {
      supplier_id: string;
      supplier_name: string;
      poc_email: string;
      tenkara_org_id: string;
      org_name: string;
    }[];
    try {
      supplierRows = await tenkaraQuery(
        `
        SELECT DISTINCT s.id::text AS supplier_id, s.name AS supplier_name, s.poc_email,
          client_org.id::text AS tenkara_org_id, client_org.name AS org_name
        FROM suppliers s
        JOIN material_quotes mq ON mq.supplier_id = s.id
        JOIN materials m ON m.id = mq.material_id
        JOIN users u ON u.id = m.user_id
        JOIN organizations client_org ON client_org.id = u.organization_id
        WHERE s.id = ANY($1::uuid[])
          ${ONLY_ORGS.length ? "AND client_org.name = ANY($2)" : ""}
        `,
        ONLY_ORGS.length ? [supplierIds, ONLY_ORGS] : [supplierIds]
      );
    } catch (e: any) {
      await ctx.log(`Tenkara supplier query failed: ${e.message}`, { level: "error", step: "suppliers" });
      ctx.setStatus("failure");
      ctx.setSummary(`Failed loading suppliers: ${e.message}`);
      return;
    }

    const suppliers = new Map<string, SupplierRef>();
    for (const r of supplierRows) {
      if (suppliers.has(r.supplier_id)) continue;
      const email = lc(r.poc_email);
      if (!EMAIL_RE.test(email)) continue;
      suppliers.set(r.supplier_id, {
        supplier_id: r.supplier_id,
        supplier_name: r.supplier_name,
        supplier_email: email,
        tenkara_org_id: r.tenkara_org_id,
        addresses: new Set([email]),
      });
    }

    // Replies often arrive from a colleague rather than the address we wrote to;
    // supplier_email_aliases records those so they count as inbound.
    const { data: aliasRows } = await admin
      .from("supplier_email_aliases")
      .select("supplier_id, email")
      .in("supplier_id", supplierIds);
    for (const a of aliasRows ?? []) {
      const s = suppliers.get((a as any).supplier_id);
      const em = lc((a as any).email);
      if (s && EMAIL_RE.test(em)) s.addresses.add(em);
    }

    await ctx.log(
      `Resolved ${suppliers.size}/${supplierIds.length} suppliers${ONLY_ORG_LABEL ? ` for ${ONLY_ORG_LABEL}` : ""}`,
      { step: "suppliers", data: { resolved: suppliers.size, requested: supplierIds.length, scope: ONLY_ORG_LABEL } }
    );
    if (suppliers.size === 0) {
      ctx.setStatus("success");
      ctx.setSummary("No tracked suppliers among the recent threads.");
      ctx.setItemsProcessed(0);
      return;
    }

    // 3. Walk each thread's message history and accumulate per supplier.
    const accum = new Map<string, ThreadAccum>(); // keyed by supplier_id
    let threadMisses = 0;
    for (const t of budgeted) {
      const ref = suppliers.get(t.supplier_id);
      if (!ref) continue;
      const details = await getTenkaraConversationDetails(t.thread_id);
      if (!details.found) {
        threadMisses++;
        continue;
      }

      let a = accum.get(t.supplier_id);
      if (!a) {
        a = {
          ref,
          org_id: t.org_id,
          lastOutboundAt: null,
          lastInboundAt: null,
          messageCount: 0,
          latestConversationId: t.thread_id,
          latestInbound: null,
          latestOutbound: null,
          transcript: [],
        };
        accum.set(t.supplier_id, a);
      }

      for (const m of details.messages) {
        if (!m.sent_at) continue;
        const at = Date.parse(m.sent_at);
        if (Number.isNaN(at)) continue;
        const text = messageText(m);
        if (!text) continue;
        const inbound = ref.addresses.has(lc(m.from_email));

        a.messageCount += 1;
        a.transcript.push({ who: inbound ? "them" : "us", at, text });
        if (inbound) {
          if (!a.lastInboundAt || at > a.lastInboundAt) {
            a.lastInboundAt = at;
            a.latestInbound = text;
            a.latestConversationId = t.thread_id;
          }
        } else if (!a.lastOutboundAt || at > a.lastOutboundAt) {
          a.lastOutboundAt = at;
          a.latestOutbound = text;
        }
      }
    }

    if (accum.size === 0) {
      await ctx.log("No readable supplier threads — nothing to upsert.", {
        step: "done",
        data: { threadMisses },
      });
      ctx.setStatus(threadMisses > 0 ? "partial" : "success");
      ctx.setSummary(`Walked ${budgeted.length} threads; none readable (${threadMisses} misses).`);
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

    // Fall back to the tenkara_org_id mapping when the draft carried no org.
    const orgIdCache = new Map<string, string | null>();
    async function resolveOrgId(tenkaraOrgId: string): Promise<string | null> {
      if (orgIdCache.has(tenkaraOrgId)) return orgIdCache.get(tenkaraOrgId)!;
      const { data } = await admin.from("orgs").select("id").eq("tenkara_org_id", tenkaraOrgId).maybeSingle();
      const id = (data as any)?.id ?? null;
      orgIdCache.set(tenkaraOrgId, id);
      return id;
    }

    for (const [, a] of accum) {
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
      let summary: string | null = (a.latestInbound ?? a.latestOutbound ?? "").slice(0, 800) || null;
      let open_ask: string | null = null;
      if (client && a.lastInboundAt && summariesDone < MAX_LLM_SUMMARIES) {
        const transcript = a.transcript
          .sort((x, y) => x.at - y.at)
          .slice(-TRANSCRIPT_MESSAGES)
          .map((m) => `${m.who === "us" ? "Us" : a.ref.supplier_name}: ${m.text.slice(0, TRANSCRIPT_CHARS_PER_MESSAGE)}`)
          .join("\n\n");
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

      const org_id = a.org_id ?? (await resolveOrgId(a.ref.tenkara_org_id));
      const { error } = await admin.from("supplier_email_context").upsert(
        {
          org_id,
          run_id: ctx.runId,
          tenkara_org_id: a.ref.tenkara_org_id,
          supplier_id: a.ref.supplier_id,
          supplier_name: a.ref.supplier_name,
          supplier_email: a.ref.supplier_email,
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
        await ctx.log(`Upsert failed for ${a.ref.supplier_email}: ${error.message}`, {
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
        .join(", ")}); ${summariesDone} LLM summaries`,
      { step: "done", data: { upserted, stateCounts, summaries: summariesDone, threadMisses } }
    );
    ctx.setStatus(threadMisses > 0 ? "partial" : "success");
    ctx.setItemsProcessed(upserted);
    ctx.setSummary(
      `Built context for ${upserted} suppliers (${Object.entries(stateCounts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}).`
    );
  },
});
