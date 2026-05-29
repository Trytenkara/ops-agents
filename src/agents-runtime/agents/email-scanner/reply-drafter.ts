import Anthropic from "@anthropic-ai/sdk";

// Composes a short, professional reply to a supplier's inbound message. The
// operator reviews and sends — so this stays non-committal: acknowledge, keep
// the sourcing conversation moving, never invent prices/terms/commitments.

const MODEL = "claude-sonnet-4-5";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface ReplyInput {
  mode: "active" | "ghost";
  clientOrgName: string;
  ghostBrand?: string;
  supplierName: string | null;
  supplierContactName: string | null;
  materialName: string | null;
  originalSubject: string | null; // our outreach subject
  theirSubject: string | null;    // their reply subject
  theirPreview: string | null;    // snippet of their message
}

const SYSTEM = `You draft short, professional replies to suppliers on behalf of a procurement team. The operator will review and send — so:
- Acknowledge their message and keep the sourcing conversation moving (e.g. confirm interest, ask for the next concrete thing: pricing for a stated quantity, MOQ, lead time, a sample, or a spec/COA).
- Be concise (3-6 sentences). Warm, businesslike, no fluff.
- NEVER invent prices, quantities, commitments, ship dates, or terms. If a specific is needed, ask for it rather than stating one.
- Do not fabricate names or sign with a real person's name — end with the team sign-off provided.
- In ghost mode, only reference the ghost brand; never name the underlying client.
Return ONLY a JSON object: {"subject": "...", "body": "..."}. The body is plain text with line breaks; no greeting placeholders left unfilled.`;

function extractJson(text: string): { subject: string; body: string } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in reply output");
  const obj = JSON.parse(candidate.slice(start, end + 1));
  return { subject: String(obj.subject ?? ""), body: String(obj.body ?? "") };
}

export async function composeReply(input: ReplyInput): Promise<{ subject: string; body: string }> {
  const signoff = input.mode === "ghost" ? `${input.ghostBrand ?? "Sourcing"} Sourcing` : `${input.clientOrgName} Purchasing Team`;
  const lines = [
    `Mode: ${input.mode}`,
    `Sign off as: ${signoff}`,
    `Supplier company: ${input.supplierName ?? "(unknown)"}`,
    `Supplier contact: ${input.supplierContactName ?? "(unknown)"}`,
    `Material being sourced: ${input.materialName ?? "(unspecified)"}`,
    `Our original outreach subject: ${input.originalSubject ?? "(none)"}`,
    `Their reply subject: ${input.theirSubject ?? "(none)"}`,
    `Their message (snippet): ${input.theirPreview ?? "(not available)"}`,
    "",
    "Draft the reply.",
  ].join("\n");

  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 700,
    system: SYSTEM,
    messages: [{ role: "user", content: lines }],
  });
  const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  const draft = extractJson(text);
  if (!draft.subject) {
    draft.subject = input.theirSubject ? `Re: ${input.theirSubject.replace(/^re:\s*/i, "")}` : `Re: ${input.materialName ?? "your message"}`;
  }
  return draft;
}
