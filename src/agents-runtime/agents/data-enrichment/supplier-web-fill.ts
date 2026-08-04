import Anthropic from "@anthropic-ai/sdk";

// Reads a supplier's own site to complete their validation profile: contact
// page for POC/email/phone/address, shipping + returns policy for shipping
// terms, terms / credit-application / "how to order" pages for payment terms
// and the AP contact. Same fetch-first-then-search method as the price pull.
//
// Nothing here is inferred. A field the site does not state comes back null and
// is recorded as not_published, which is what lets the card say "not published"
// instead of showing an unexplained blank.

const MODEL = "claude-sonnet-5";
const MAX_FETCH_USES = 6;
const MAX_WEB_USES = 5;
const MAX_OUTPUT_TOKENS = 1500;
const WEB_FETCH_BETA = "web-fetch-2025-09-10";

export interface WebFillInput {
  supplier_name: string;
  website: string | null;
  known_email: string | null;
  missing: string[];
}

export interface WebFillResult {
  poc_email: string | null;
  poc_phone: string | null;
  poc_name: string | null;
  shipping_address: string | null;
  shipping_terms: string | null;
  shipping_email: string | null;
  billing_email: string | null;
  billing_poc_name: string | null;
  payment_upfront_pct: number | null;
  payment_net_days: number | null;
  payment_completion: string | null;
  payment_credit_line: string | null;
  site_found: boolean;
  source_url: string | null;
  notes: string | null;
}

const SYSTEM_PROMPT = `You complete a supplier's purchasing profile from that supplier's OWN public website.

Method:
1. web_fetch the supplier's site. Read the pages that carry this information: Contact / Contact Us, About, Locations, Shipping, Shipping & Returns, Terms & Conditions, Terms of Sale, Payment, Credit Application, Ordering / How to Order, Wholesale, Customer Service.
2. If you have no URL, or the fetch fails, or the page does not carry the field, use web_search to find the supplier's official site or the specific page ("<supplier> contact", "<supplier> terms of sale", "<supplier> credit application"), then web_fetch that page and read it.
3. Prefer the supplier's own domain. A directory, aggregator, or marketplace listing is NOT the supplier's own information.

Return ONLY a JSON object:
{
  "poc_email": string|null,          // sales / customer-service email at the supplier's own domain
  "poc_phone": string|null,          // main sales phone, as printed
  "poc_name": string|null,           // named sales/account contact, only if the page names one
  "shipping_address": string|null,   // the supplier's shipping origin or HQ, as printed
  "shipping_terms": string|null,     // verbatim, e.g. "FOB Origin", "ExWorks", "Free freight over $500"
  "shipping_email": string|null,     // logistics / shipping department email
  "billing_email": string|null,      // accounts-receivable / billing / invoices email
  "billing_poc_name": string|null,
  "payment_upfront_pct": number|null,// only if the site states a deposit/prepayment percentage
  "payment_net_days": number|null,   // only if the site states net terms, e.g. "Net 30" -> 30
  "payment_completion": string|null, // balance/completion terms, verbatim
  "payment_credit_line": string|null,// credit line / credit application terms, verbatim
  "site_found": boolean,             // true only if you actually read at least one page belonging to THIS supplier, even if it stated none of the fields
  "source_url": string|null,         // the page you read, even when it yielded nothing
  "notes": string|null               // one short line on what you could not find and why
}

Rules:
- NEVER fabricate, infer, or construct a value. No guessed emails (do not build "sales@<domain>" unless that exact address is printed), no assumed "Net 30", no inferred FOB, no address assembled from a phone area code.
- A field that is not explicitly printed on a page you actually read must be null. A blank is always better than a plausible invention.
- Reject aggregator contact details (@alibaba.com, @indiamart.com, @tradeindia.com, @thomasnet.com, helpdesk@, inquiry-form addresses). Those are not the supplier's own contact.
- Negotiated terms are usually NOT public. Returning all nulls for the payment fields is a normal, correct outcome. Do not stretch to fill them.
- site_found is about reach, not yield: true when you got a page of theirs open, false when the supplier has no findable site or every fetch failed. A false here means we try again later rather than recording their fields as unpublished.
- Take each value verbatim from the page. Do not translate, normalize, or reformat, other than converting "Net 30" style text to the number 30 for payment_net_days.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function extractJson(text: string): any {
  const fenced = text.trim().match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

const AGGREGATOR_EMAIL = /@(alibaba|indiamart|tradeindia|made-in-china|thomasnet|globalsources|ec21|exportersindia|knowde)\./i;
const PLACEHOLDER_EMAIL = /(example\.|your-?email|noreply|no-reply|@domain\.)/i;

function cleanEmail(v: any): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  if (AGGREGATOR_EMAIL.test(s) || PLACEHOLDER_EMAIL.test(s)) return null;
  return s;
}

const cleanText = (v: any): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && s.toLowerCase() !== "null" && s.length < 500 ? s : null;
};

const cleanNum = (v: any, max: number): number | null => {
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.]/g, "")) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

export async function webFillSupplierProfile(input: WebFillInput): Promise<WebFillResult> {
  const lines = [
    `Supplier: ${input.supplier_name}`,
    `Website on file: ${input.website ?? "unknown, find it"}`,
    input.known_email ? `Known contact email: ${input.known_email}` : null,
    `Fields still missing: ${input.missing.join(", ")}`,
    "",
    "Read this supplier's own site and return the JSON.",
  ].filter(Boolean);

  const res = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    betas: [WEB_FETCH_BETA],
    system: SYSTEM_PROMPT,
    tools: [
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: MAX_FETCH_USES } as any,
      { type: "web_search_20260209", name: "web_search", max_uses: MAX_WEB_USES } as any,
    ],
    messages: [{ role: "user", content: lines.join("\n") }],
  });

  const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch {
    return {
      poc_email: null, poc_phone: null, poc_name: null, shipping_address: null,
      shipping_terms: null, shipping_email: null, billing_email: null, billing_poc_name: null,
      payment_upfront_pct: null, payment_net_days: null, payment_completion: null, payment_credit_line: null,
      site_found: false, source_url: null, notes: `Model returned no JSON: ${text.slice(0, 160)}`,
    };
  }

  return {
    poc_email: cleanEmail(parsed.poc_email),
    poc_phone: cleanText(parsed.poc_phone),
    poc_name: cleanText(parsed.poc_name),
    shipping_address: cleanText(parsed.shipping_address),
    shipping_terms: cleanText(parsed.shipping_terms),
    shipping_email: cleanEmail(parsed.shipping_email),
    billing_email: cleanEmail(parsed.billing_email),
    billing_poc_name: cleanText(parsed.billing_poc_name),
    payment_upfront_pct: cleanNum(parsed.payment_upfront_pct, 100),
    payment_net_days: cleanNum(parsed.payment_net_days, 365),
    payment_completion: cleanText(parsed.payment_completion),
    payment_credit_line: cleanText(parsed.payment_credit_line),
    site_found: parsed.site_found === true || !!cleanText(parsed.source_url),
    source_url: cleanText(parsed.source_url),
    notes: cleanText(parsed.notes),
  };
}
