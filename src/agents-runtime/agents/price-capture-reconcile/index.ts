import Anthropic from "@anthropic-ai/sdk";
import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTenkaraConversationMessages } from "@/lib/tenkara";
import { postAgentAlert } from "@/lib/slack-alert";

// Agent 24 - Price Capture Reconciliation.
//
// DATA-15's detection half. The extractor counts the price points a supplier's
// message states before it extracts any of them (message_price_capture), and
// this reads back the messages where fewer prices were stored than were stated.
//
// It exists because a missed price used to leave no trace whatsoever. Nothing
// was written when the extractor read a message as priceless, so there was no
// denominator: the only measure of the extractor was its own output. In the
// California Chemicals audit that hid three suppliers who had quoted a firm
// price (Shandong Depu usd1300/mt, Sinochem Nanjing USD1450/MT, Hefei TNJ
// usd1490/mt) and three more prices dropped from suppliers we did capture. All
// six sat in the inbox for weeks, and the only reason any of them surfaced was
// a person reading the emails by hand.
//
// The second read is a MODEL read of the original message, never another price
// regex (META-07). The first read already failed; a pattern list built from the
// misses we know about would only ever catch the misses we know about, and the
// next one will not look like the last one.
//
// Reports, never repairs. It does not stage the price it finds: the first read
// got this message wrong once already, and a second automated read that writes
// its answer straight into the client's data is the same bet twice. An operator
// gets the message and the count, and enters the number.

const MODEL = "claude-sonnet-4-5";
const LOOKBACK_DAYS = 14;
const SAMPLE = 8;

// A shortfall is only worth a model call if the message is still worth working.
// Older than this and the quote is stale anyway; the row is left unreconciled
// rather than marked clean, so nothing claims it was checked.
const MAX_BATCH = 40;

const SECOND_READ_PROMPT = `You are re-reading one supplier email that our price extractor has already read once. It reported that the message states N price points but we only stored M of them, and you are checking whether that shortfall is real.

Answer the narrow question only: which price points does this message state, and what are they? Read the whole message including any quoted history below the reply.

A "price point" is any figure the supplier offers as a price for a material: one rung of a tiered ladder, one pack size, a revised price and the price it revises, a price stated only in passing ("we were at 1.49 last time, now 1.53"). Count and list each separately.

Return ONLY JSON:
{
  "price_points": [
    {
      "quote": "the supplier's own words, verbatim, one short fragment",
      "amount": 1300,
      "currency": "USD",
      "unit": "MT",
      "material": "what it is a price for, as they name it, or null"
    }
  ],
  "note": "one sentence for an operator: what is here, or why nothing is"
}

Rules:
- quote must be copied from the message exactly. If you cannot copy the words, you did not read a price.
- amount must appear inside quote. Never compute one: "518lbs at 1.1975/lb" is a price of 1.1975, not 620.54.
- unit is the one written against the number. "usd1280/mt" is MT, never kg, even when a kg packing figure sits in the same sentence.
- currency null when the supplier states none. Do not assume USD.
- An empty array is a real and useful answer. Say so in note.
- Never invent a price, and never repeat a price from our own outbound text as if the supplier stated it.`;

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

interface PricePoint {
  quote: string;
  amount: number | null;
  currency: string | null;
  unit: string | null;
  material: string | null;
}

async function secondRead(body: string, stated: number, stored: number): Promise<{ points: PricePoint[]; note: string } | null> {
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SECOND_READ_PROMPT,
    messages: [
      {
        role: "user",
        content: `Our first read reported ${stated} price point(s) in this message and we stored ${stored}.\n\nMessage:\n\n${body.slice(0, 24000)}`,
      },
    ],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const points: PricePoint[] = (Array.isArray(parsed?.price_points) ? parsed.price_points : [])
      .map((p: any) => ({
        quote: typeof p?.quote === "string" ? p.quote.trim() : "",
        amount: Number.isFinite(Number(p?.amount)) ? Number(p.amount) : null,
        currency: typeof p?.currency === "string" ? p.currency.trim().toUpperCase() || null : null,
        unit: typeof p?.unit === "string" ? p.unit.trim() || null : null,
        material: typeof p?.material === "string" ? p.material.trim() || null : null,
      }))
      // A point with no words behind it is the same fabrication this whole rule
      // exists to stop, so it does not count as a found price.
      .filter((p: PricePoint) => p.quote.length > 0);
    return { points, note: typeof parsed?.note === "string" ? parsed.note.trim() : "" };
  } catch {
    return null;
  }
}

registerAgent({
  slug: "agent-24-price-capture-reconcile",
  displayName: "Agent 24 - Price Capture Reconciliation",
  description:
    "Re-reads supplier messages where the extractor said more prices were stated than we stored, using a second model read of the original email. Confirms or clears each shortfall and alerts on the confirmed misses. Reports, never stages a price.",
  async run(ctx) {
    const admin = createAdminClient();
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

    // Unreconciled shortfalls only. A row already judged stays judged: re-reading
    // it every night would burn the model budget on the same answer and train
    // everyone to ignore the alert.
    const { data: rows, error } = await admin
      .from("message_price_capture")
      .select("message_id, conversation_id, org_id, supplier_name, price_points_present, quotes_extracted, rows_staged, received_at")
      .is("reconciled_at", null)
      .not("price_points_present", "is", null)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(MAX_BATCH);
    if (error) throw new Error(`shortfall query failed: ${error.message}`);

    const shortfalls = (rows ?? []).filter((r: any) => (r.price_points_present ?? 0) > (r.rows_staged ?? 0));
    // AUTO-08: name the window rather than let the cap read as "all of them".
    await ctx.log(
      `${shortfalls.length} unreconciled shortfall(s) in the last ${LOOKBACK_DAYS}d` +
        (rows?.length === MAX_BATCH ? `, capped at the ${MAX_BATCH} most recent messages; the rest stay queued for the next run` : ""),
      { step: "load" }
    );

    if (!shortfalls.length) {
      ctx.setItemsProcessed(0);
      ctx.setStatus("success");
      ctx.setSummary(`Clean: every message read in the last ${LOOKBACK_DAYS} days stored as many prices as it stated.`);
      return;
    }

    const confirmed: string[] = [];
    let cleared = 0;
    let unreadable = 0;

    for (const r of shortfalls as any[]) {
      let verdict: "confirmed_miss" | "no_miss" | "unreadable" = "unreadable";
      let note = "";
      try {
        const messages = await getTenkaraConversationMessages(r.conversation_id);
        const msg = messages.find((m) => m.id === r.message_id);
        const body = (msg?.body_html || msg?.body_text || "").trim();
        if (!body) {
          note = "The original message could not be read back from Tenkara.";
        } else {
          const read = await secondRead(body, r.price_points_present ?? 0, r.rows_staged ?? 0);
          if (!read) {
            note = "The second read returned nothing usable.";
          } else if (read.points.length > (r.rows_staged ?? 0)) {
            verdict = "confirmed_miss";
            note = `${read.points.length} price point(s) in the message, ${r.rows_staged} stored. ${read.points
              .map((p) => `"${p.quote}"`)
              .join(" ")} ${read.note}`.trim();
            confirmed.push(
              `${r.supplier_name ?? "unknown supplier"} — ${read.points.length} stated, ${r.rows_staged} stored: ${read.points
                .slice(0, 3)
                .map((p) => p.quote)
                .join(" | ")}`
            );
          } else {
            verdict = "no_miss";
            cleared++;
            note = read.note || "Second read found no price beyond what we stored.";
          }
        }
      } catch (e: any) {
        note = `Second read failed: ${e?.message ?? e}`;
      }
      if (verdict === "unreadable") unreadable++;
      // Only a verdict we actually reached is recorded. An unreadable message
      // stays flagged as unreconciled work rather than being written off:
      // reconciled_at stays null so the next run picks it up again.
      await admin
        .from("message_price_capture")
        .update({
          reconciled_at: verdict === "unreadable" ? null : new Date().toISOString(),
          reconcile_verdict: verdict,
          reconcile_note: note.slice(0, 2000),
        })
        .eq("message_id", r.message_id);
    }

    ctx.setItemsProcessed(shortfalls.length);
    ctx.setMetadata({ confirmed: confirmed.length, cleared, unreadable });

    if (confirmed.length) {
      await postAgentAlert(
        `:mag: *Supplier prices we did not capture* (last ${LOOKBACK_DAYS}d)\n` +
          confirmed.slice(0, SAMPLE).map((c) => `• ${c}`).join("\n") +
          (confirmed.length > SAMPLE ? `\n• …and ${confirmed.length - SAMPLE} more` : "") +
          `\nNothing was staged automatically: the first read already got these wrong once. Enter the figures from the supplier's own words.`,
        {
          severity: "p2",
          title: "Price capture reconciliation",
          key: `price_capture_reconcile:${confirmed.length}`,
          ttlMinutes: 60 * 20,
        }
      );
    }

    ctx.setStatus(confirmed.length || unreadable ? "partial" : "success");
    ctx.setSummary(
      `${shortfalls.length} shortfall(s) re-read: ${confirmed.length} confirmed miss(es), ${cleared} cleared, ${unreadable} could not be read back.`
    );
  },
});
