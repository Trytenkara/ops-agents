import Anthropic from "@anthropic-ai/sdk";

// One-quote price re-check. Asks Anthropic with the web_search server-side
// tool to (a) visit the product URL we have on file, (b) check that the
// product still exists, (c) report the current public price + pack size.
// No browser, no logins, no scraping in our code - the model drives the
// search and we parse its JSON response.

const MODEL = "claude-opus-4-5";
const MAX_WEB_USES = 6;
const MAX_OUTPUT_TOKENS = 1024;

export interface RecheckInput {
  supplier_name: string;
  material_name: string;
  product_url: string;
  baseline_price: number | null;
  case_size: number | null;
  unit: string | null;
}

export interface RecheckResult {
  classification: "current_price_found" | "link_broken" | "needs_review";
  current_price: number | null;
  pack_size: string | null;            // free-text e.g. "50 lb"
  source_url: string | null;
  source_citations: string[];
  notes: string | null;
}

const SYSTEM_PROMPT = `You are a B2B sourcing analyst checking whether a marketplace's current listed price for a material matches what we have on file.

You will be given: the supplier name, material name, our baseline price/case_size/unit, and the product_url we have stored.

Use the web_search tool to:
1. Visit the product_url (and follow obvious redirects).
2. If that fails, try one query like "<supplier_name> <material_name> price" to find the current product page.
3. Read the current listed price for the closest matching pack size (the one most similar to our baseline case_size + unit).

Return ONLY a JSON object (no prose) like:

\`\`\`json
{
  "classification": "current_price_found | link_broken | needs_review",
  "current_price": 99.99,
  "pack_size": "50 lb",
  "source_url": "https://supplier.com/...",
  "source_citations": ["https://...", "..."],
  "notes": "one-line summary; mention if pack size differs from baseline"
}
\`\`\`

Rules:
- "link_broken" ONLY for hard 404 / product removed / redirect to category page.
- "needs_review" for ambiguous cases: login wall, multiple SKUs on page, currency mismatch, price requires quote, page exists but pack size differs significantly.
- "current_price_found" only when you have a concrete numeric price for an equivalent pack size.
- current_price must be a numeric USD value (or null). Strip currency symbols.
- source_url must be the actual product page you read from, not a search result.
- Never fabricate. If the price is not visible publicly, return needs_review with a note explaining why.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

function extractJson(text: string): any {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

function buildUserMessage(input: RecheckInput): string {
  const lines: string[] = [];
  lines.push(`Supplier: ${input.supplier_name}`);
  lines.push(`Material: ${input.material_name}`);
  lines.push(`Product URL on file: ${input.product_url}`);
  lines.push(`Baseline price: ${input.baseline_price ?? "unknown"}`);
  lines.push(`Baseline pack size: ${input.case_size ?? "?"} ${input.unit ?? ""}`.trim());
  lines.push("");
  lines.push("Re-check the current public price and return the JSON.");
  return lines.join("\n");
}

export async function recheckMarketplaceQuote(input: RecheckInput): Promise<RecheckResult> {
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [{
      type: "web_search_20250305",
      name: "web_search",
      max_uses: MAX_WEB_USES,
    } as any],
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });
  const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch {
    return {
      classification: "needs_review",
      current_price: null,
      pack_size: null,
      source_url: input.product_url,
      source_citations: [],
      notes: `Model returned no JSON: ${text.slice(0, 200)}`,
    };
  }

  const cls = parsed.classification;
  const validCls = cls === "current_price_found" || cls === "link_broken" || cls === "needs_review"
    ? cls
    : "needs_review";

  let price: number | null = null;
  if (typeof parsed.current_price === "number" && Number.isFinite(parsed.current_price)) {
    price = parsed.current_price;
  } else if (typeof parsed.current_price === "string") {
    const cleaned = parsed.current_price.replace(/[^0-9.\-]/g, "");
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) price = n;
  }

  return {
    classification: validCls,
    current_price: price,
    pack_size: typeof parsed.pack_size === "string" ? parsed.pack_size : null,
    source_url: typeof parsed.source_url === "string" ? parsed.source_url : input.product_url,
    source_citations: Array.isArray(parsed.source_citations)
      ? parsed.source_citations.filter((u: any) => typeof u === "string").slice(0, 8)
      : [],
    notes: typeof parsed.notes === "string" ? parsed.notes : null,
  };
}
