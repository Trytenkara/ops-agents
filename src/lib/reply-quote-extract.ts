import Anthropic from "@anthropic-ai/sdk";

// Extract supplier pricing from the TEXT of an email reply. This is the inline
// counterpart to email-scanner/attachment-parser.ts (which handles PDF/Excel
// price sheets). On Tenkara, inbound replies arrive via webhook with body text
// only — no attachments — so this is the one price-capture path we can run
// without a Tenkara-side change. Read-only: produces extracted data; nothing is
// sent. Staged quotes go to the ops dashboard for operator review.

const MODEL = "claude-sonnet-4-5";

export interface ExtractedQuote {
  supplier_name: string | null;
  material_name: string | null;
  price: number | null; // per-case price, currency-stripped
  case_size: number | null;
  unit_of_measurement: string | null;
  currency: string | null;
  confidence: "high" | "medium" | "low";
  notes: string | null;
}

const SYSTEM_PROMPT = `You are a B2B sourcing analyst extracting supplier price quotes from the plain text of an email a supplier sent us in reply to a sourcing request.

Only extract prices the supplier ACTUALLY STATES in the text. Most replies won't contain a firm price (they ask a question, promise a quote later, attach a sheet, or decline) — in those cases return {"quotes": []}. Do not guess.

Return ONLY a JSON object (no prose):
{
  "quotes": [
    {
      "supplier_name": "string or null (the supplier/company)",
      "material_name": "string (the material/product the price is for)",
      "price": 99.99,                 // numeric, currency symbols stripped; price for one case/unit as stated
      "case_size": 25,                // numeric quantity the price covers (e.g. 25 for a 25 kg bag); null if unclear
      "unit_of_measurement": "kg",    // the unit case_size is in (kg, lb, L, each, ...)
      "currency": "USD",
      "confidence": "high | medium | low",
      "notes": "anything ambiguous: MOQ, tiered pricing, unclear unit, sample vs bulk, etc."
    }
  ]
}

Rules:
- price must be numeric or null. Strip "$", "USD", commas.
- Populate case_size and unit_of_measurement so a PER-UNIT price (price / case_size) can be computed. If the price is already per-unit, set case_size = 1 and unit_of_measurement to that unit. Only leave case_size null if there is genuinely no quantity context.
- Capture EVERY pack size and EVERY tiered price break as its OWN line; put quantity thresholds in notes (e.g. "tier: >=500 lb").
- confidence "low" when the unit/case size is guessed or the figure might be an MOQ/sample price rather than a real quote.
- NEVER invent materials, pack sizes, or prices. If the reply states no price, return {"quotes": []}.`;

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function extractJson(text: string): { quotes: ExtractedQuote[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { quotes: [] };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed?.quotes) ? { quotes: parsed.quotes } : { quotes: [] };
  } catch {
    return { quotes: [] };
  }
}

// Returns [] on empty/short text, no prices found, or any extraction error —
// price capture must never break the reply-drafting flow.
export async function extractQuotesFromReplyText(body: string | null | undefined): Promise<ExtractedQuote[]> {
  const text = (body ?? "").trim();
  if (text.length < 12) return [];
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Supplier reply text:\n\n${text.slice(0, 12000)}` }],
  });
  const out = res.content.find((b) => b.type === "text");
  return extractJson(out && out.type === "text" ? out.text : "").quotes.filter(
    (q) => q && (q.price != null || q.material_name)
  );
}
