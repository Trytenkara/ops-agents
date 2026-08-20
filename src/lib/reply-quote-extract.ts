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
  // How many distinct price points the message states, counted before any were
  // turned into quote lines (DATA-15). This is the denominator: without it a
  // missed price leaves no trace and the extractor is graded on its own output.
  // Deliberately a count, not a flag — Foodchem stated three prices and we took
  // one, and "did this message have a price" answers yes to that.
  pricePointsPresent: number | null;
  details: ExtractedQuoteDetails;
  declined: boolean;
  // Whether the supplier said they can ship to the US, when they said either way.
  // Null = they did not raise it. Deliberately separate from `declined`: a
  // supplier that cannot ship to the US but can supply the material is a live
  // lead we buy at origin, not a decline.
  shipsToUs: "yes" | "no" | null;
  // Their own words behind that verdict, for the operator badge.
  shipsToUsEvidence: string | null;
  // Other COMPANIES this supplier pointed us at (a manufacturer they buy from, a
  // sister concern, their US distributor). These become new leads of their own.
  referrals: ReferredSupplier[];
}

export interface ReferredSupplier {
  company_name: string;
  website: string | null;
  email: string | null;
  contact_name: string | null;
  phone: string | null;
  // How the supplier described them, so an operator can see why we have this lead.
  note: string | null;
}

export interface ExtractedQuote {
  supplier_name: string | null;
  material_name: string | null;
  price: number | null; // per-case price, currency-stripped
  // The supplier's own words this price was read out of (DATA-14). Verified
  // against the number and unit before the price can be published; a price
  // whose fragment does not contain it was computed, not read.
  price_source_text: string | null;
  case_size: number | null; // quantity the supplier stated the price covers; null when unstated
  unit_price_gap_reason: string | null; // why case_size (and so unit_price) is null
  unit_of_measurement: string | null;
  currency: string | null;
  incoterm: string | null; // supplier-stated delivery term (EXW, FOB, CIF, ...), never inferred
  incoterm_location: string | null; // the named place on that term ("Shanghai"), null when bare
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
  "price_points_present": 0,  // count FIRST, before extracting: how many distinct price points this message states
  "declined": false,
  "ships_to_us": null,
  "ships_to_us_evidence": null,
  "referrals": [],
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
      "price_source_text": "USD 99.99/kg FOB Ningbo",  // REQUIRED with any price: the supplier's own words, copied exactly
      "case_size": 25,                // quantity the supplier says the price covers; null if they never said
      "unit_price_gap_reason": null,  // why case_size is null, in one sentence; null when case_size is set
      "unit_of_measurement": "kg",    // the unit case_size is in (kg, lb, L, each, ...)
      "currency": "USD",
      "incoterm": "FOB",              // the delivery term IF the supplier states one, else null
      "incoterm_location": "Shanghai",// the named place on that term, else null
      "grade": "USP",                 // the material grade IF the supplier states one, else null
      "lead_time_days": 21,           // supplier's stated lead time normalized to DAYS, else null
      "lead_time_text": "2-3 weeks ARO", // the raw lead-time phrasing as written, else null
      "moq_quantity": 500,            // minimum order quantity as a number, else null
      "moq_unit": "kg",               // the unit the MOQ is in (kg, lb, cases, drums, ...), else null
      "payment_terms": "Net 30",      // stated payment terms, else null
      "confidence": "high | medium | low",
      "notes": "anything ambiguous not captured by a field above: sample vs bulk, unclear unit, etc."
    }
  ],
  "referrals": [
    {
      "company_name": "the OTHER company they told us to contact",
      "website": "their site if given, else null",
      "email": "their email if given, else null",
      "contact_name": "a person at that company if given, else null",
      "phone": "their phone if given, else null",
      "note": "how the supplier described them, one short phrase"
    }
  ]
}

Rules:
- price_points_present: before you extract anything, read the message and count how many distinct price points it states. Count EVERY rung of EVERY ladder and every pack size separately (a 4-tier table is 4), count a revised price and the price it revises as 2, and count a price stated only in quoted history. Count it even when you cannot tell what quantity it covers or what currency it is in — the question is how many the SUPPLIER stated, not how many you were able to use. This is checked against how many rows we store, and a shortfall sends the message back for a second read, so do not round it down to match your own quotes array and do not report 0 because the prices looked unusable.
- price must be numeric or null. Strip currency symbols and codes, commas.
- price_source_text is MANDATORY whenever price is not null: copy the supplier's own words that state this price, exactly as written, including the number, its currency and its unit ("usd1280/mt FOB Qingdao", "Drums are 518lbs at 1.1975/lb"). One short fragment, not the whole email, and not your summary of it. It is checked: the number you report and the unit you report must both appear in the fragment, and a quote whose fragment does not contain them is withheld from the client as unverifiable. Two consequences to be deliberate about. NEVER do arithmetic on a supplier's figure — not division by a pack size, and not multiplication by one either ("518lbs at 1.1975/lb" is a price of 1.1975, never 620.54). And report the unit THE SUPPLIER WROTE AGAINST THE NUMBER: "usd1280/mt" is per tonne, so unit_of_measurement is "MT" and never "kg", even when a kg figure appears elsewhere in the same sentence as a packing detail.
- currency: the ISO 4217 code the price is stated in ("USD", "EUR", "GBP", "INR", "CNY", ...). Infer from the symbol/locale (€→EUR, £→GBP, ₹ or "Rs"/"Rs."→INR, ¥→CNY or JPY by supplier, $→USD unless clearly CAD/AUD/etc.). We convert to USD ourselves — report the currency AS STATED, do NOT convert. CURRENCY IS HIGH-STAKES: a price reported in the wrong currency gets published as a wildly wrong USD number (₹149 shown as $149 is ~85x too high). Do NOT default to USD just because there is no symbol — many suppliers (Indian, Chinese, Pakistani, etc.) quote in domestic currency. If you cannot positively confirm the currency, return null (better a blank than a wrong currency) and note the ambiguity.
- grade: only populate if the supplier EXPLICITLY names a grade/spec for the material (e.g. "USP", "EP", "Food grade", "Industrial", "SCI 80"). NEVER infer or guess a "typical" grade — if they don't state one, return null.
- incoterm: the delivery term the supplier attaches to THIS price, as a bare Incoterms code in caps (EXW, FOB, FCA, CFR, CIF, CIP, DAP, DDP, ...). Put the named place in incoterm_location ("FOB Shanghai" is incoterm "FOB", incoterm_location "Shanghai"; "ex factory"/"ex works" is EXW; "CIF by sea" is CIF with a null location). Both null when the supplier states no term. NEVER infer a term from the supplier's country, the price level, or a shipping sentence that names no term: two prices on different terms are not the same price, and an assumed EXW on a CIF quote understates landed cost.
- case_size is the quantity THE PRICE APPLIES TO, and only the supplier can tell you that. If the price is already per-unit, set case_size = 1 and unit_of_measurement to that unit. If the supplier ties the price to a quantity ("$250 per 25kg drum"), that quantity is case_size.
- A PACKAGING line is NOT a price basis. Suppliers routinely state price, incoterm, and packing as three independent facts ("USD 2900 / 20ft FOB MUNDRA / PACKING - 25KG PP BAG" quotes a container, not a $2,900 bag). Never divide a price by a pack/packing/drum/bag spec to manufacture a per-unit figure. Do not treat MOQ, a container size, or a tier threshold as the basis either.
- When you cannot tell from the supplier's own words what quantity the price covers: set case_size = null, keep price exactly as stated, and write unit_price_gap_reason explaining the ambiguity in one operator-readable sentence (e.g. "Supplier stated USD 2900 with a 20ft container and a 25kg bag packing line; which one the price covers is not stated."). A blank per-unit price is correct here. A guessed one gets published as a real number, so guessing is the more expensive error.
- unit_price_gap_reason must be null whenever case_size is populated.
- Capture EVERY pack size and EVERY tiered price break as its OWN line; put quantity thresholds in notes (e.g. "tier: >=500 lb").
- lead_time_days: only when the supplier states a lead/delivery time. Normalize to days (1 week = 7, "2-3 weeks" = 21 using the upper bound, "1 month" = 30). Keep the exact original wording in lead_time_text. If no lead time is stated, both are null. NEVER guess a "typical" lead time.
- moq_quantity / moq_unit: the supplier's stated minimum order quantity and its unit. Null if not stated. Do not confuse MOQ with case_size — MOQ is the smallest total order they'll accept.
- payment_terms: the stated payment/credit terms verbatim-ish ("Net 30", "Net 60", "50% deposit, balance on delivery", "prepaid"). Null if not stated. NEVER assume terms.
- These per-supplier fields (lead_time_*, moq_*, payment_terms) are the SAME for every line in one reply unless the supplier differentiates. Repeat them on each quote line and in details when stated.
- details: populate only values explicitly stated by the supplier. Case dimensions require length, width, height, unit, and case weight as separate fields. Never infer missing components.
- details.case_size follows the SAME rule as a quote's case_size: it is the quantity a price applies to, not the packaging quantity. A supplier answering "we pack in 215 kg drums" has told you a pack size, not a price basis — that belongs in case_weight/case_type, and details.case_size stays null.
- contact/shipping/billing details: capture only the supplier's own business information they explicitly provide. Do not copy our buyer address/signature into these fields.
- declined: true ONLY for a clear hard decline or explicit statement that they cannot supply the requested material. Out-of-office, automated, ambiguous, or substitute-only messages are not hard declines unless they clearly reject the requested material.
- ships_to_us: "no" when the supplier says they cannot or do not ship, export, or deliver to the United States (including "domestic sales only", "we only supply within India", "no export"), "yes" when they say they can ship to the US or already export there, null when they do not raise it. Put the sentence you read it from in ships_to_us_evidence, verbatim and trimmed to one sentence, else null.
- NOT SHIPPING TO THE US IS NOT A DECLINE. A supplier who can supply the material but cannot ship it to the US is still a supplier: we collect at origin. Set ships_to_us "no" and leave declined false. Only set declined true if they cannot supply the MATERIAL.
- referrals: ONLY a different company the supplier explicitly points us to for this material or one like it (the manufacturer they buy from, a sister or group company, their distributor, "try X, they make it"). Requires a real company NAME in their text. NEVER the supplier's own company, NEVER our own company, NEVER a courier/bank/certifying body/marketplace they merely mention, and NEVER an inferred or "typical" supplier. A different MATERIAL they pitch is not a referral. If they name nobody, return an empty array. Do not put their own contact details on a referral: those belong in details.
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

const str = (v: any): string | null => (typeof v === "string" ? v.trim() || null : null);

function extractJson(text: string): ReplyQuoteExtraction {
  // pricePointsPresent stays null, never 0, when we could not read the model's
  // answer. Null means "we do not know how many prices this message held", and a
  // zero would assert the opposite — which is the exact claim a miss makes.
  const empty = (): ReplyQuoteExtraction => ({ quotes: [], pricePointsPresent: null, details: { ...EMPTY_DETAILS }, declined: false, shipsToUs: null, shipsToUsEvidence: null, referrals: [] });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return empty();
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      quotes: Array.isArray(parsed?.quotes)
        ? parsed.quotes
            .filter((q: any) => q && (q.price != null || q.material_name))
            .map((q: any) => ({
              ...q,
              price_source_text:
                typeof q.price_source_text === "string" ? q.price_source_text.trim() || null : null,
              unit_price_gap_reason:
                typeof q.unit_price_gap_reason === "string" ? q.unit_price_gap_reason.trim() || null : null,
              incoterm: typeof q.incoterm === "string" ? q.incoterm.trim().toUpperCase() || null : null,
              incoterm_location: typeof q.incoterm_location === "string" ? q.incoterm_location.trim() || null : null,
            }))
        : [],
      pricePointsPresent:
        Number.isFinite(Number(parsed?.price_points_present)) && Number(parsed.price_points_present) >= 0
          ? Math.round(Number(parsed.price_points_present))
          : null,
      details: { ...EMPTY_DETAILS, ...(parsed?.details && typeof parsed.details === "object" ? parsed.details : {}) },
      declined: parsed?.declined === true,
      shipsToUs: parsed?.ships_to_us === "yes" || parsed?.ships_to_us === "no" ? parsed.ships_to_us : null,
      shipsToUsEvidence:
        typeof parsed?.ships_to_us_evidence === "string" ? parsed.ships_to_us_evidence.trim() || null : null,
      referrals: Array.isArray(parsed?.referrals)
        ? parsed.referrals
            .map((r: any) => ({
              company_name: typeof r?.company_name === "string" ? r.company_name.trim() : "",
              website: str(r?.website),
              email: str(r?.email)?.toLowerCase() ?? null,
              contact_name: str(r?.contact_name),
              phone: str(r?.phone),
              note: str(r?.note),
            }))
            .filter((r: ReferredSupplier) => r.company_name.length > 1)
        : [],
    };
  } catch {
    return empty();
  }
}

export async function extractQuotesFromReplyText(body: string | null | undefined): Promise<ReplyQuoteExtraction> {
  const text = (body ?? "").trim();
  // A body this short holds nothing, so zero prices is a fact here, not a guess.
  if (text.length < 12) return { quotes: [], pricePointsPresent: 0, details: { ...EMPTY_DETAILS }, declined: false, shipsToUs: null, shipsToUsEvidence: null, referrals: [] };
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Supplier reply body (text or HTML):\n\n${text.slice(0, 20000)}` }],
  });
  const out = res.content.find((b) => b.type === "text");
  return extractJson(out && out.type === "text" ? out.text : "");
}
