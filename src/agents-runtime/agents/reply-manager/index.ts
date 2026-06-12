import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { getConversationMessages, getMessage, htmlToText } from "@/lib/missive";
import { stageDraft } from "@/lib/draft-staging";
import { postAgentAlert } from "@/lib/slack-alert";
import Anthropic from "@anthropic-ai/sdk";

// Real Bobber Labs context (from bobberlabs.com / how the client is set up).
// The agent may use ONLY what's here for company context — never beyond it.
// Long-term, per-client order specs (PO quantities, ship-to, grades) come from
// Tackle Box client settings; until then they're unknown and must be asked for.
const BOBBER_LABS_PROFILE = `Bobber Labs is a supplement contract manufacturer. We do NOT know order quantities, ship-to locations, or material grades unless they are stated in our original outreach below or provided by ops. Those are not to be guessed.`;

// Slack user to tag on gap/bounce alerts (the operator who fills client gaps).
const ALERT_USER_ID = process.env.OPS_ALERT_SLACK_USER_ID || "U09PNM3K0QH";

// Agent 15 - Supplier Reply Manager.
// Owns the supplier-facing conversation AFTER Agent 08 detects a reply. For each
// thread with a reply and no finalized price, it classifies the reply and drafts
// the right next message per our email workflow (answer a question, reframe a
// "no record" reply as a fresh pricing ask, or nudge for the missing price),
// staged as a Missive draft for a human to send. Persistence is light: one
// follow-up, then the thread is handed to ops. It never sends.
//
// It also maintains flow_status on each draft_references row so the pipeline
// board can show where every thread is, all the way to a finalized price.

const MODEL = "claude-opus-4-5";
const MAX_FOLLOW_UPS = 1; // "light" persistence per ops decision

// flow_status lifecycle (stored on draft_references.metadata.flow_status):
//   outreach_sent -> reply_received -> responded -> price_captured -> finalized
//   plus terminal: stale (no price after the follow-up budget) / closed_declined.
type FlowStatus =
  | "outreach_sent"
  | "reply_received"
  | "responded"
  | "awaiting_human"   // we need info we don't have; a human was Slacked
  | "bounced"          // delivery failure; need another address for the supplier
  | "price_captured"
  | "finalized"
  | "stale"
  | "closed_declined";

interface Classification {
  category: "price_given" | "no_record" | "question" | "partial" | "declined" | "auto_reply";
  needs_response: boolean;
  needs_info: boolean;        // responding requires info we don't have -> ask a human
  info_questions: string[];   // the specific gaps to ask the human
  supplyable_materials: string[]; // materials they CAN supply (dropped ones they don't carry)
  subject: string;
  body: string;
  reason: string;
}

// Deterministic safety net: the model keeps "forgetting" the ask, so if a
// response doesn't contain an explicit pricing question, we append one built
// from the materials they can supply, before the sign-off.
function ensurePricingAsk(body: string, materials: string[]): string {
  const hasAsk = /\?/.test(body) && /(pricing|price|lead time|moq|quote)/i.test(body);
  if (hasAsk || materials.length === 0) return body;
  const list =
    materials.length === 1
      ? materials[0]
      : `${materials.slice(0, -1).join(", ")} and ${materials[materials.length - 1]}`;
  const ask = `Could you share your current pricing, lead time, and MOQ for ${list}? We can confirm exact volumes as we go.`;
  const idx = body.search(/\n\s*Thanks,/i);
  if (idx >= 0) return `${body.slice(0, idx).trimEnd()}\n\n${ask}\n${body.slice(idx).replace(/^\n+/, "")}`;
  return `${body.trimEnd()}\n\n${ask}`;
}

const SYSTEM = `You manage a procurement team's supplier email thread for Bobber Labs. We previously asked a supplier to confirm/refresh pricing. Given their latest reply, classify it and, when useful, draft our next message. The operator reviews and SENDS it.

BOBBER LABS PROFILE (the ONLY company facts you may use):
${BOBBER_LABS_PROFILE}

ABSOLUTE RULE — NEVER FABRICATE:
Never state a quantity, volume, order size, grade, ship-to, ZIP, price, or date we don't actually have.

HOW WE OPERATE (important): We are gathering supplier pricing. We do NOT need to tell a supplier our order quantity, ship-to, or grade to get a quote — we simply ask for THEIR current pricing, lead time, and MOQ for the materials, and confirm exact volumes later. So missing order specs on our side is NORMAL and is NOT a reason to stall. Just ask the supplier for their pricing.

needs_info is for genuine blockers only: set it true ONLY if the supplier explicitly asks a specific question we cannot answer from OUR ORIGINAL OUTREACH or the profile AND it truly blocks any reply. Do NOT set needs_info just because we lack a quantity/ship-to/grade — in that case still draft the pricing ask.

Classify into exactly one category:
- "price_given": they provided pricing (or attached a price list). No further chase needed.
- "no_record": they have no record / can't tie our quote back. Reframe: drop the old-quote angle and ask for their CURRENT pricing, lead time, and MOQ for the listed materials. If they say they don't carry a material, drop that material.
- "question": they asked us something. Answer ONLY from given context; if it needs info we don't have, set needs_info=true.
- "partial": they replied but the price is missing/incomplete. Nudge specifically for the missing pricing.
- "declined": they can't or won't supply. Acknowledge and close gracefully.
- "auto_reply": out-of-office / automated / non-human (NOT a bounce — bounces are handled separately). No response.

needs_response: true only for no_record, question, partial (and declined -> a brief courteous close). false for price_given and auto_reply.
needs_info: leave FALSE in almost all cases. We can always ask a supplier for their pricing without our order specs. Only set true for a genuine blocker per the rule above. Lacking a quantity/ship-to/grade is NOT a blocker - still draft the pricing ask.

DRAFTING RULES when needs_response is true and needs_info is false:
- Greet the contact by FIRST name when we have one ("Hi Andre,"); otherwise "Hi {Company} Team,".
- Respond to what they ACTUALLY said (e.g. drop a material they don't carry), not a template.
- The draft is INVALID unless its closing paragraph is an explicit pricing ask that NAMES the materials they can supply. Required form: "Could you share your current pricing, lead time, and MOQ for <Material A> and <Material B>?" Vague closers ("we can nail down details", "happy to work from your terms", "once we see what works") are forbidden.
- You may reference our prior pricing (in OUR ORIGINAL OUTREACH) lightly, never insist on it.

GOOD EXAMPLE (supplier says no record + doesn't carry Cetearyl):
Hi Andre,

Thanks for the quick reply, and no problem on the records.

Good to know you don't carry Cetearyl Alcohol, we will take that one off our list.

Could you share your current pricing, lead time, and MOQ for Acetone and Citric Acid? We can confirm exact volumes as we go.

Thanks,

Procurement Team
Bobber Labs

VOICE: warm, lightly informal, professional. Every thought its own short paragraph with a blank line between. Body under 120 words. NEVER use em or en dashes. Never fabricate prior calls. Sign off EXACTLY:
Thanks,

Procurement Team
Bobber Labs

Return ONLY JSON: {"category":"...","needs_response":true|false,"needs_info":true|false,"info_questions":["..."],"supplyable_materials":["Acetone","Citric Acid"],"subject":"...","body":"...","reason":"<one line>"}. supplyable_materials = the materials they CAN supply (drop any they said they don't carry). If needs_response is false or needs_info is true, subject/body may be empty strings.`;

const sani = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/\n{3,}/g, "\n\n").trim();

let anthro: Anthropic | null = null;
function ai(): Anthropic {
  if (!anthro) anthro = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthro;
}

async function classifyAndDraft(opts: {
  supplierName: string | null;
  contactName: string | null;
  materials: string[];
  ourSubject: string | null;
  ourOutreach: string | null;
  theirSubject: string | null;
  theirBody: string | null;
}): Promise<Classification | null> {
  const user = [
    `Supplier company: ${opts.supplierName ?? "(unknown)"}`,
    `Their contact name: ${opts.contactName ?? "(unknown)"}`,
    `Materials in our outreach: ${opts.materials.join(", ") || "(unspecified)"}`,
    "",
    "OUR ORIGINAL OUTREACH (includes any prior pricing we have on file):",
    opts.ourOutreach ?? "(not available)",
    "",
    `Their reply subject: ${opts.theirSubject ?? ""}`,
    "THEIR FULL REPLY:",
    opts.theirBody ?? "(no text captured)",
    "",
    "Classify their reply and, if needed, draft our next message per the rules.",
  ].join("\n");
  const res = await ai().messages.create({ model: MODEL, max_tokens: 900, system: SYSTEM, messages: [{ role: "user", content: user }] });
  const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const p = JSON.parse(text.slice(s, e + 1));
    return {
      category: p.category,
      needs_response: !!p.needs_response,
      needs_info: !!p.needs_info,
      info_questions: Array.isArray(p.info_questions) ? p.info_questions.map(String) : [],
      supplyable_materials: Array.isArray(p.supplyable_materials) ? p.supplyable_materials.map(String) : [],
      subject: sani(String(p.subject ?? "")),
      body: sani(String(p.body ?? "")),
      reason: String(p.reason ?? ""),
    };
  } catch {
    return null;
  }
}

registerAgent({
  slug: "agent-15-reply-manager",
  displayName: "Agent 15 - Supplier Reply Manager",
  description:
    "Owns the supplier conversation after a reply is detected: classifies the reply and drafts the right next message (answer, reframe a no-record reply as a fresh pricing ask, or nudge for the missing price), staged for a human to send. Light persistence (1 follow-up). Tracks flow_status to a finalized price. Never sends.",
  async run(ctx) {
    if (!process.env.ANTHROPIC_API_KEY) {
      ctx.setStatus("failure");
      ctx.setSummary("ANTHROPIC_API_KEY missing.");
      return;
    }
    const admin = createAdminClient();

    // Threads with a detected reply that aren't finalized/closed yet. Group by
    // conversation so we act once per thread, not once per material row.
    const { data: refs, error } = await admin
      .from("draft_references")
      .select("id, org_id, supplier_id, material_id, thread_id, subject, body_preview, assigned_operator, metadata")
      .not("metadata->reply_detected", "is", null);
    if (error) {
      await ctx.log(`draft_references pull failed: ${error.message}`, { level: "error", step: "pull" });
      ctx.setStatus("failure");
      ctx.setSummary(`Pull failed: ${error.message}`);
      return;
    }

    const byThread = new Map<string, any[]>();
    for (const r of refs ?? []) {
      const key = (r as any).thread_id ?? (r as any).id;
      const arr = byThread.get(key) ?? [];
      arr.push(r);
      byThread.set(key, arr);
    }

    let responded = 0, priced = 0, stale = 0, closed = 0, skipped = 0, bounced = 0, awaitingHuman = 0;
    for (const [threadId, rows] of byThread) {
      const head: any = rows[0];
      const meta = head.metadata ?? {};
      const status: FlowStatus = meta.flow_status ?? "reply_received";
      if (["price_captured", "finalized", "stale", "closed_declined", "awaiting_human", "bounced"].includes(status)) { skipped++; continue; }

      // If a price already landed for this thread, mark it and move on.
      const supplierIds = rows.map((r) => r.supplier_id).filter(Boolean);
      let hasPrice = false;
      if (supplierIds.length) {
        const { count } = await admin
          .from("staged_quotes")
          .select("id", { count: "exact", head: true })
          .in("supplier_id", supplierIds as string[]);
        hasPrice = (count ?? 0) > 0;
      }
      if (hasPrice) {
        await setStatus(admin, rows, "price_captured", { note: "staged_quote present" });
        priced++;
        continue;
      }

      const followUps = Number(meta.reply_followups ?? 0);
      if (followUps >= MAX_FOLLOW_UPS) {
        await setStatus(admin, rows, "stale", { note: `no price after ${followUps} follow-up(s)` });
        stale++;
        continue;
      }

      // Read the supplier's FULL reply (single-message endpoint returns the body;
      // the conversation list only has a preview).
      const replyMsgId = meta.reply_detected?.reply_message_id as string | undefined;
      let theirBody: string | null = meta.reply_detected?.reply_preview ?? null;
      let theirSubject: string | null = meta.reply_detected?.reply_subject ?? null;
      let contactName: string | null = meta.reply_detected?.reply_sender_name ?? null;
      let senderAddr: string | null = meta.reply_detected?.reply_sender_email ?? null;
      try {
        if (replyMsgId) {
          const full = await getMessage(replyMsgId);
          if (full) {
            theirBody = htmlToText(full.body) || full.preview || theirBody;
            theirSubject = full.subject ?? theirSubject;
            contactName = full.from_field?.name ?? contactName;
            senderAddr = full.from_field?.address ?? senderAddr;
          }
        } else {
          const convId = meta.reply_detected?.reply_conversation_id ?? threadId;
          const msgs = await getConversationMessages(convId, 10);
          const inbound = msgs.filter((m) => !m.draft && m.from_field?.address && m.from_field.address.toLowerCase() !== "info@bobberlabs.com");
          const latest = inbound.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
          if (latest) { theirBody = latest.preview ?? theirBody; theirSubject = latest.subject ?? theirSubject; contactName = latest.from_field?.name ?? contactName; }
        }
      } catch (e: any) {
        await ctx.log(`Missive fetch failed for ${replyMsgId ?? threadId}: ${e.message}`, { level: "warn", step: "fetch" });
      }

      // Bounce / delivery failure -> never thank anyone; alert ops to find another address.
      if (isBounce(senderAddr, theirSubject)) {
        await postAgentAlert(
          `:warning: *Bounce* on outreach to *${meta.supplier_name ?? meta.supplier_contact_email ?? "a supplier"}* (${meta.supplier_contact_email ?? "?"}). The email did not deliver. Please find another email source for this supplier.`,
          { mentionUserId: ALERT_USER_ID }
        );
        await setStatus(admin, rows, "bounced", { note: `bounce from ${senderAddr ?? "?"}` });
        bounced++;
        await ctx.log(`Bounce on ${meta.supplier_name ?? threadId}`, { step: "bounce" });
        continue;
      }

      const materials = Array.from(new Set(rows.map((r) => (r.metadata as any)?.material_name).filter(Boolean)));
      const cls = await classifyAndDraft({
        supplierName: meta.supplier_name ?? null,
        contactName,
        materials,
        ourSubject: head.subject ?? null,
        ourOutreach: head.body_preview ?? null,
        theirSubject,
        theirBody,
      });
      if (!cls) { skipped++; continue; }

      // Gap: responding needs info we don't have -> ask a human, never fabricate.
      if (cls.needs_info) {
        const qs = cls.info_questions.length ? cls.info_questions : ["order quantity, grade, and ship-to for the materials"];
        await postAgentAlert(
          `:wrench: *Gap-fill needed* for *${meta.supplier_name ?? "supplier"}* (${meta.supplier_contact_email ?? "?"}). To reply without fabricating, I need:\n${qs.map((q) => `• ${q}`).join("\n")}\nReply here and I will draft it.`,
          { mentionUserId: ALERT_USER_ID }
        );
        await setStatus(admin, rows, "awaiting_human", { note: `needs_info: ${qs.join("; ")}` });
        awaitingHuman++;
        await ctx.log(`Gap-fill alerted for ${meta.supplier_name ?? threadId}`, { step: "gap" });
        continue;
      }

      if (cls.category === "price_given") { await setStatus(admin, rows, "price_captured", { note: "supplier provided price (await extraction)" }); priced++; continue; }
      if (cls.category === "auto_reply") { skipped++; continue; }
      if (!cls.needs_response || !cls.body) {
        if (cls.category === "declined") { await setStatus(admin, rows, "closed_declined", { note: cls.reason }); closed++; }
        else skipped++;
        continue;
      }

      // Reply to the address they actually replied FROM (often different from the
      // mailbox we wrote to — e.g. andre@ vs sales@). Store it as the contact
      // going forward so future outreach uses the live address.
      const replyAddr = (senderAddr || meta.supplier_contact_email || "").toString();
      const to = { name: contactName ?? meta.supplier_name ?? null, address: replyAddr };
      if (!to.address) { skipped++; continue; }
      if (senderAddr && senderAddr.toLowerCase() !== (meta.supplier_contact_email ?? "").toLowerCase()) {
        for (const r of rows) {
          r.metadata = { ...(r.metadata ?? {}), supplier_contact_email: senderAddr, supplier_contact_name: contactName ?? (r.metadata as any)?.supplier_contact_name, prior_contact_email: (r.metadata as any)?.supplier_contact_email };
        }
        await ctx.log(`Updated contact for ${meta.supplier_name ?? threadId} -> ${senderAddr}`, { step: "contact-update" });
      }
      const finalBody = sani(ensurePricingAsk(cls.body, cls.supplyable_materials.length ? cls.supplyable_materials : materials));
      const staged = await stageDraft({
        admin, agentId: ctx.agentId, runId: ctx.runId, orgId: head.org_id,
        supplierId: head.supplier_id, materialId: head.material_id,
        to, subject: cls.subject || `Re: ${head.subject ?? "your quote"}`, body: finalBody,
        assignedOperator: head.assigned_operator ?? null,
        emailClient: "missive",
        metadata: { outreach_mode: "ghost", ghost_brand: "Bobber Labs", supplier_contact_email: replyAddr, draft_kind: "reply_manager_response", reply_category: cls.category, staged_via: "agent-15" },
      });
      if (staged.ok) {
        await setStatus(admin, rows, cls.category === "declined" ? "closed_declined" : "responded", {
          note: `${cls.category}: ${cls.reason}`,
          incrementFollowup: cls.category !== "declined",
        });
        if (cls.category === "declined") closed++; else responded++;
        await ctx.log(`Responded to ${meta.supplier_name ?? to.address} (${cls.category})`, { step: "respond", data: { category: cls.category } });
      } else {
        skipped++;
        await ctx.log(`Stage failed for ${to.address}: ${staged.error}`, { level: "warn", step: "respond" });
      }
    }

    ctx.setItemsProcessed(responded + priced + stale + closed + bounced + awaitingHuman);
    ctx.setStatus("success");
    ctx.setSummary(`Threads: ${byThread.size} · ${responded} responded · ${priced} priced · ${awaitingHuman} awaiting-human · ${bounced} bounced · ${stale} stale · ${closed} closed · ${skipped} skipped`);
  },
});

// Heuristic bounce / delivery-failure detector (sender or subject).
function isBounce(senderAddr: string | null, subject: string | null): boolean {
  const a = (senderAddr ?? "").toLowerCase();
  const s = (subject ?? "").toLowerCase();
  if (/mailer-daemon|postmaster@|maildelivery|mail-daemon/.test(a)) return true;
  if (/undeliverable|delivery status notification|delivery (has )?failed|failure notice|returned mail|address not found|recipient.*(reject|not found)|message could not be delivered|mail delivery failed/.test(s)) return true;
  return false;
}

async function setStatus(
  admin: ReturnType<typeof createAdminClient>,
  rows: any[],
  status: FlowStatus,
  opts: { note?: string; incrementFollowup?: boolean }
) {
  for (const r of rows) {
    const meta = r.metadata ?? {};
    const history = Array.isArray(meta.flow_history) ? meta.flow_history : [];
    const patch: Record<string, any> = {
      ...meta,
      flow_status: status,
      flow_history: [...history, { status, at: new Date().toISOString(), note: opts.note ?? null }].slice(-12),
    };
    if (opts.incrementFollowup) patch.reply_followups = Number(meta.reply_followups ?? 0) + 1;
    await admin.from("draft_references").update({ metadata: patch }).eq("id", r.id);
  }
}
