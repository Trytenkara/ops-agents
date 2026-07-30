import Anthropic from "@anthropic-ai/sdk";

// Extract supplier pricing from the TEXT of an email reply. This is the inline
// counterpart to email-scanner/attachment-parser.ts (which handles PDF/Excel
// price sheets). On Tenkara, inbound replies arrive via webhook with body text
// only — no attachments — so this is the one price-capture path we can run
// without a Tenkara-side change. Read-only: produces extracted data; nothing is
// sent. Staged quotes go to the ops dashboard for operator review.

const MODEL = "claude-sonnet-4-5";

export interface ExtractedQuoteDetails {
  material_name: string | null;
  case_size: number | null;
  unit_of_measurement: string | null;
  case_type: string | null;
  case_length: number | null;
  case_width: number | null;
  case_height: number | null;
  dimensions_unit: string | null;
  case_weight: number | null;
  lead_time_days: number | null;
  lead_time_text: string | null;
  moq_quantity: number | null;
  moq_unit: string | null;
  payment_terms: string | null;
  poc_name: string | null;
  poc_email: string | null;
  poc_phone: string | null;
  shipping_address: string | null;
  shipping_terms: string | null;
  shipping_email: string | null;
  billing_email: string | null;
  billing_poc_name: string | null;
}

export interface ReplyQuoteExtraction {
  quotes: ExtractedQuote[];
  details: ExtractedQuoteDetails;
  declined: boolean;
}

export interface ExtractedQuote {
  supplier_name: string | null;
  material_name: string | null;
  price: number | null; // per-case price, currency-stripped
  case_size: number | null;
  unit_of_measurement: string | null;
  currency: string | null;
  grade: string | null; // supplier-stated material grade, never guessed
  lead_time_days: number | null; // normalized to days when stated; else null
  lead_time_text: string | null; // raw stated lead time ("2-3 weeks", "ARO")
  moq_quantity: number | null; // minimum order quantity, numeric
  moq_unit: string | null; // unit the MOQ is expressed in (kg, lb, cases, ...)
  payment_terms: string | null; // "Net 30", "50% deposit", etc.
  confidence: "high" | "medium" | "low";
  notes: string | null;
}

const SYSTEM_PROMPT = `You are a B2B sourcing analyst extracting supplier price quotes from the body of an email a supplier sent us in reply to a sourcing request. The input may be plain text OR raw HTML — if it's HTML, read the rendered content, and pay special attention to <table> price ladders (pack size / tier / price columns).

Only extract facts the supplier ACTUALLY STATES in the text. Most replies won't contain a firm price but may answer a prior question about MOQ, lead time, packaging, payment terms, or supplier details. Capture those answers in the details object even when quotes is empty. Do not guess.

Return ONLY a JSON object (no prose):
{
  "declined": false,
  "details": {
    "material_name": "material these details apply to, or null",
    "case_size": null,
    "unit_of_measurement": null,
    "case_type": null,
    "case_length": null,
    "case_width": null,
    "case_height": null,
    "dimensions_unit": null,
    "case_weight": null,
    "lead_time_days": null,
    "lead_time_text": null,
    "moq_quantity": null,
    "moq_unit": null,
    "payment_terms": null,
    "poc_name": null,
    "poc_email": null,
    "poc_phone": null,
    "shipping_address": null,
    "shipping_terms": null,
    "shipping_email": null,
    "billing_email": null,
    "billing_poc_name": null
  },
  "quotes": [
    {
      "supplier_name": "string or null (the supplier/company)",
      "material_name": "string (the material/product the price is for)",
      "price": 99.99,                 // numeric, currency symbols stripped; price for one case/unit as stated
      "case_size": 25,                // numeric quantity the price covers (e.g. 25 for a 25 kg bag); null if unclear
      "unit_of_measurement": "kg",    // the unit case_size is in (kg, lb, L, each, ...)
      "currency": "USD",
      "grade": "USP",                 // the material grade IF the supplier states one, else null
      "lead_time_days": 21,           // supplier's stated lead time normalized to DAYS, else null
      "lead_time_text": "2-3 weeks ARO", // the raw lead-time phrasing as written, else null
      "moq_quantity": 500,            // minimum order quantity as a number, else null
      "moq_unit": "kg",               // the unit the MOQ is in (kg, lb, cases, drums, ...), else null
      "payment_terms": "Net 30",      // stated payment terms, else null
      "confidence": "high | medium | low",
      "notes": "anything ambiguous not captured by a field above: sample vs bulk, unclear unit, etc."
    }
  ]
}

Rules:
- price must be numeric or null. Strip "$", "USD", commas.
- grade: only populate if the supplier EXPLICITLY names a grade/spec for the material (e.g. "USP", "EP", "Food grade", "Industrial", "SCI 80"). NEVER infer or guess a "typical" grade — if they don't state one, return null.
- Populate case_size and unit_of_measurement so a PER-UNIT price (price / case_size) can be computed. If the price is already per-unit, set case_size = 1 and unit_of_measurement to that unit. Only leave case_size null if there is genuinely no quantity context.
- Capture EVERY pack size and EVERY tiered price break as its OWN line; put quantity thresholds in notes (e.g. "tier: >=500 lb").
- lead_time_days: only when the supplier states a lead/delivery time. Normalize to days (1 week = 7, "2-3 weeks" = 21 using the upper bound, "1 month" = 30). Keep the exact original wording in lead_time_text. If no lead time is stated, both are null. NEVER guess a "typical" lead time.
- moq_quantity / moq_unit: the supplier's stated minimum order quantity and its unit. Null if not stated. Do not confuse MOQ with case_size — MOQ is the smallest total order they'll accept.
- payment_terms: the stated payment/credit terms verbatim-ish ("Net 30", "Net 60", "50% deposit, balance on delivery", "prepaid"). Null if not stated. NEVER assume terms.
- These per-supplier fields (lead_time_*, moq_*, payment_terms) are the SAME for every line in one reply unless the supplier differentiates. Repeat them on each quote line and in details when stated.
- details: populate only values explicitly stated by the supplier. Case dimensions require length, width, height, unit, and case weight as separate fields. Never infer missing components.
- contact/shipping/billing details: capture only the supplier's own business information they explicitly provide. Do not copy our buyer address/signature into these fields.
- declined: true ONLY for a clear hard decline or explicit statement that they cannot supply the requested material. Out-of-office, automated, ambiguous, or substitute-only messages are not hard declines unless they clearly reject the requested material.
- confidence "low" when the unit/case size is unclear or the figure might be an MOQ/sample price rather than a real quote.
- NEVER invent materials, pack sizes, prices, contact details, addresses, or terms. If the reply states no price, quotes must be empty but details may still contain supplier-stated answers.`;

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

const EMPTY_DETAILS: ExtractedQuoteDetails = {
  material_name: null,
  case_size: null,
  unit_of_measurement: null,
  case_type: null,
  case_length: null,
  case_width: null,
  case_height: null,
  dimensions_unit: null,
  case_weight: null,
  lead_time_days: null,
  lead_time_text: null,
  moq_quantity: null,
  moq_unit: null,
  payment_terms: null,
  poc_name: null,
  poc_email: null,
  poc_phone: null,
  shipping_address: null,
  shipping_terms: null,
  shipping_email: null,
  billing_email: null,
  billing_poc_name: null,
};

function extractJson(text: string): ReplyQuoteExtraction {
  const empty = (): ReplyQuoteExtraction => ({ quotes: [], details: { ...EMPTY_DETAILS }, declined: false });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return empty();
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      quotes: Array.isArray(parsed?.quotes) ? parsed.quotes.filter((q: any) => q && (q.price != null || q.material_name)) : [],
      details: { ...EMPTY_DETAILS, ...(parsed?.details && typeof parsed.details === "object" ? parsed.details : {}) },
      declined: parsed?.declined === true,
    };
  } catch {
    return empty();
  }
}

export async function extractQuotesFromReplyText(body: string | null | undefined): Promise<ReplyQuoteExtraction> {
  const text = (body ?? "").trim();
  if (text.length < 12) return { quotes: [], details: { ...EMPTY_DETAILS }, declined: false };
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Supplier reply body (text or HTML):\n\n${text.slice(0, 20000)}` }],
  });
  const out = res.content.find((b) => b.type === "text");
  return extractJson(out && out.type === "text" ? out.text : "");
}
