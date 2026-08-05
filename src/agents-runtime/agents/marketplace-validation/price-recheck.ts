import Anthropic from "@anthropic-ai/sdk";
import { aggregatorNameOf, isAggregatorIndexUrl, isAggregatorPlatformName } from "@/lib/aggregator-hosts";

// One-quote price re-check. Asks Anthropic with the web_search server-side
// tool to (a) visit the product URL we have on file, (b) check that the
// product still exists, (c) report the current public price + pack size.
// No browser, no logins, no scraping in our code - the model drives the
// search and we parse its JSON response.

const MODEL = "claude-sonnet-5";
const MAX_WEB_USES = 6;   // web_search calls (link repair)
const MAX_FETCH_USES = 5; // web_fetch calls (read the actual product page)
const MAX_OUTPUT_TOKENS = 2048; // room for a full multi-tier ladder + JSON
const MAX_OUTPUT_TOKENS_ENUM = 8000; // a seller roster is far longer than one price; 2048 truncates it mid-array
const WEB_FETCH_BETA = "web-fetch-2025-09-10";

export interface RecheckInput {
  supplier_name: string;
  material_name: string;
  product_url: string;
  baseline_price: number | null;
  case_size: number | null;
  unit: string | null;
  // Optional per-call model override. Defaults to MODEL (Sonnet). The marketplace
  // lead re-check path passes a cheaper model here since re-checks only compare
  // against a known baseline (lower stakes than a first-time extraction).
  model?: string;
  // Set when the lead looks like an aggregator index page (the platform itself
  // recorded as the supplier, or a category/search/showroom URL). Switches the
  // reader from "find one price" to "list the individual sellers on this page"
  // so the caller can split it into one lead per real company.
  enumerate_sellers?: boolean;
}

// One third-party company listed on an aggregator index page.
export interface AggregatorSeller {
  supplier_name: string;
  product_url: string;
  country: string | null;
  price: number | null;
  currency: string | null;
  pack_size: string | null;
  moq: string | null;
}

export interface PriceTier {
  pack_size: string | null; // free-text e.g. "25 kg"
  price: number | null;     // total price for that pack
  unit_price: number | null; // per-unit ($/kg, $/lb…) when derivable
}

export interface RecheckResult {
  classification: "current_price_found" | "link_broken" | "needs_review" | "login_required" | "not_marketplace";
  // Which price category the page belongs to. "aggregator" = a multi-seller
  // inquiry platform (Alibaba, IndiaMART, ...): the number is an indicative ask,
  // not a checkout price, so it is kept but filtered and labelled separately.
  market_kind: "marketplace" | "aggregator";
  aggregator: string | null;           // display name of the aggregator, e.g. "IndiaMART"
  current_price: number | null;
  currency: string | null;             // ISO code of current_price/tiers as listed (e.g. "USD","EUR")
  pack_size: string | null;            // free-text e.g. "50 lb"
  unit_price: number | null;           // best (lowest) per-unit price seen
  tiers: PriceTier[];                  // every visible pack-size / volume-break tier
  // Level-2 listing fields — captured verbatim off the page when visible, else
  // null. Never inferred. Downstream parses these into quote/supplier profiles.
  moq: string | null;                  // minimum order quantity as printed, e.g. "Min. order: 25 kg"
  lead_time: string | null;            // lead time / dispatch time as printed, e.g. "Ships in 3-5 business days"
  shipping: string | null;             // shipping terms as printed, e.g. "Free shipping over $100"
  source_url: string | null;
  source_citations: string[];
  notes: string | null;
  // Set only when enumerate_sellers was requested: the page turned out to be a
  // multi-seller index, and these are the individual companies listed on it.
  index_page: boolean;
  sellers: AggregatorSeller[];
  // The read never happened: the API errored, the model returned no JSON, or it
  // ran out of tokens mid-read. Nothing was learned about the page, so callers
  // must not treat this as a verdict or let it advance a backoff.
  infra_failure?: boolean;
}

const SYSTEM_PROMPT = `You are a B2B sourcing analyst checking whether a marketplace's current listed price for a material matches what we have on file.

You will be given: the supplier name, material name, our baseline price/case_size/unit, and the product_url we have stored.

Use the web_fetch and web_search tools:
1. web_fetch the product_url and READ the page itself — the current listed price and EVERY visible pack-size / volume-break tier, stock status, and whether pricing is public or gated. (web_fetch reads the real page; do not rely on search snippets when you can fetch.)
2. If the fetched page does NOT show a public numeric price for THIS material — i.e. it is a dead link, a PDF/datasheet, a contact / RFQ / "request a quote" page, a homepage, a showroom, a category / search-results listing, or the WRONG product — you MUST use web_search to locate the correct DIRECT product page for this supplier + material (queries like "<supplier_name> <material_name> price" and "<material_name> buy <supplier_name>"), then web_fetch that page and read it. Prefer the supplier's own product page over a directory. Do NOT return link_broken or needs_review for a bad on-file URL until you have tried at least one web_search followed by a web_fetch of a better page. Only classify login_required (behind a login / "request price") or needs_review AFTER a genuine product page still yields no public price.
3. CHECKOUT IS THE TRUEST TEST OF A MARKETPLACE. A visible price is NOT enough. Before reporting a price, confirm the page has an actual online purchase path for this material — an add-to-cart / "buy now" / online-checkout / place-order control you could click through to buy. If the page shows a price (or price range) but has NO way to check out — it is a plain price listing, a distributor list-price page, or a B2B listing that routes every order through a quote/inquiry form — then it is NOT a marketplace: return classification "not_marketplace". Do not report its number. (A sign-in/registration wall in front of an otherwise real checkout is "login_required", not "not_marketplace".)
3b. AGGREGATORS ARE THE ONE EXCEPTION, and they are their own category. An aggregator is a MULTI-SELLER platform hosting many third-party sellers, where ordering happens through a "Send Inquiry" / "Contact Supplier" / "Get latest price" form rather than a checkout — Alibaba, IndiaMART, Made-in-China, DHgate, 1688, Global Sources, TradeIndia, ExportersIndia, EC21, TradeKey and the like. There, inquiry-only IS the normal shape, and the printed number is still worth recording as an indicative ask. For those pages return classification "aggregator" AND report the price and tiers exactly as you would for a marketplace. The multi-seller relay is what makes it an aggregator: a SINGLE company's own site with no checkout is "not_marketplace", never "aggregator".
4. Report the current listed price for the closest matching pack size (the one most similar to our baseline case_size + unit), plus every visible tier.

Return ONLY a JSON object (no prose) like:

\`\`\`json
{
  "classification": "current_price_found | aggregator | link_broken | needs_review | login_required | not_marketplace",
  "current_price": 99.99,
  "currency": "USD",
  "pack_size": "50 lb",
  "unit_price": 2.00,
  "tiers": [
    {"pack_size": "1 kg", "price": 25.00},
    {"pack_size": "25 kg", "price": 450.00}
  ],
  "moq": "Min. order: 25 kg",
  "lead_time": "Ships in 3-5 business days",
  "shipping": "Free shipping over $100",
  "source_url": "https://supplier.com/...",
  "source_citations": ["https://...", "..."],
  "notes": "one-line summary; mention if pack size differs from baseline"
}
\`\`\`

Rules:
- "tiers": capture EVERY visible pack-size / quantity / volume-break price on the page as its own entry (e.g. "1 kg $25", "25 kg $450", or an "As low as $18.00 for 100+ kg" break → {"pack_size":"100 kg","price":1800.00}). Empty array if none are visible.
- "unit_price": the best (lowest) per-unit price you can derive across the tiers (price ÷ quantity, e.g. 450/25 = 18.00 per kg). Numeric or null.
- "current_price" + "pack_size" stay the single closest match to our baseline pack size (for the change comparison).
- "aggregator" when the page is a multi-seller inquiry platform (see rule 3b): report current_price, pack_size, unit_price and tiers normally — we keep aggregator numbers, we just file them separately as indicative asks. Do NOT use "not_marketplace" for these.
- "not_marketplace" when the page has a price but NO online checkout — a plain price listing, a distributor list-price page, or a B2B listing where every order goes through a quote/inquiry form. There is nothing to add to a cart or check out. This is not a marketplace, so we will not publish its price. Leave current_price/tiers null/empty.
- "login_required" when the price is hidden behind a sign-in / registration / "create an account" / "log in to see price" wall — i.e. it could be read by a human who signs up, but not publicly. Ops will sign up and pull it manually. (Only when a real checkout sits behind the wall — if there is no checkout at all, use "not_marketplace".)
- "link_broken" ONLY for hard 404 / product removed / redirect to category page.
- "needs_review" for other ambiguous cases: multiple SKUs on page, price requires a custom quote/RFQ, page exists but pack size differs significantly.
- "current_price_found" only when you have a concrete numeric price for an equivalent pack size on a real checkout marketplace (use "aggregator" instead when the page is a multi-seller inquiry platform).
- current_price and tier prices must be numeric, in the currency AS LISTED on the page. Strip currency symbols to a plain number.
- "currency": the ISO 4217 code the listed prices are in — "USD", "EUR", "GBP", "INR", "CNY", etc. Infer from the currency symbol/locale (€→EUR, £→GBP, ₹ or "Rs"/"Rs."/"₹"→INR, ¥→CNY or JPY by site, $→USD unless clearly CAD/AUD/etc.). We convert to USD ourselves — do NOT convert; report the listed currency.
- CURRENCY IS HIGH-STAKES: a price reported in the wrong currency is published as a wildly wrong USD number (e.g. ₹149 shown as $149 is ~85x too high). Do NOT default to USD just because you see a bare "$" or no symbol. Many suppliers — especially Indian, Chinese, Pakistani, and other non-US firms — list domestic-currency prices (₹/Rs, ¥/RMB) even on ".com" sites and even when a "$" appears. If the page shows ₹ or "Rs"/"Rs." anywhere near the price, it is INR, not USD. Consider the supplier's country, the site locale, and whether the price magnitude makes sense for this material in USD (bulk industrial chemicals are typically low single-digit $/kg — a "per kg" price of $60-$800 is almost always a local-currency figure mislabeled).
- If you cannot POSITIVELY confirm the currency from the page (symbol, explicit code, or a clear locale/magnitude signal), return "needs_review" with a note explaining the ambiguity — do NOT guess "USD". A blank is better than a wrong currency.
- "moq" / "lead_time" / "shipping": capture these ONLY if they are explicitly printed on the product page, copied verbatim (e.g. "Minimum order 25 kg", "Usually ships in 2-3 business days", "Free shipping on orders over $100"). If the page does not show it, return null. Never infer a minimum from the smallest pack size, never assume a default lead time, never guess shipping. These are optional and must not affect the classification or price.
- source_url must be the actual product page you read from, not a search result.
- Never fabricate, infer, estimate, round, or back-calculate a price. Only report a number that is explicitly printed on the page for that exact pack size. If the price only appears after selecting a size/variant you cannot confirm was rendered, or you are otherwise unsure of the exact figure, return needs_review — a blank is better than a guess.
- Never fabricate. If a public price isn't visible, return login_required (if it's behind a login) or needs_review, with a note explaining why.`;

// Appended only when the caller flagged the lead as a suspected aggregator index
// page. It overrides rule 2 for that one case: instead of searching away from a
// category/search/showroom listing, read the sellers off it so the caller can
// replace the umbrella row with one lead per real company.
const INDEX_PAGE_RULES = `

AGGREGATOR INDEX PAGE (this lead is suspected to be one — this section OVERRIDES rule 2 for a category/search/showroom page):
The platform is never the supplier. If the page you fetch is an aggregator CATEGORY, SEARCH-RESULTS or SHOWROOM listing showing products from MANY different third-party sellers, do NOT search for a different page and do NOT report a single price for it: the numbers on it belong to different companies. Instead set "index_page": true and enumerate the sellers into "sellers".

For each seller listed on the page report:
- "supplier_name": the SELLING COMPANY's own name as printed (e.g. "Hebei Yanxi Chemical Co., Ltd."). NEVER the platform's name, never "multiple sellers", never a product name.
- "product_url": the URL of THAT SELLER's own product listing or storefront on the platform, as linked from the page. Never the index URL you were given.
- "country", "price", "currency", "pack_size", "moq": as printed for that seller, else null.

Rules for "sellers":
- Up to 8 sellers, in the order they appear. Skip any row you cannot attribute to a named company with its own link (sponsored blocks, "related searches", bare product tiles).
- Every seller must be selling THIS material, on THIS platform. Aggregator index pages are often JavaScript-rendered and come back empty: if that happens you may read the same platform's own listing for the SAME material instead (its country page, its search results, a "<material> suppliers" page). Never switch to a different material and never list sellers off another platform. If the only pages you can read are for a different product, return an empty "sellers" array.
- Never invent a seller name, URL, or price. Only list what you actually read on the page. An empty array is correct if the page shows no attributable sellers.
- Leave current_price, tiers, moq, lead_time and shipping null/empty when "index_page" is true. Use classification "aggregator".
- If the page is actually ONE seller's own listing (a single company's product page on the platform), set "index_page": false, leave "sellers" empty, and handle it normally per the rules above.`;

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

function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function buildUserMessage(input: RecheckInput): string {
  const lines: string[] = [];
  lines.push(`Supplier: ${input.supplier_name}`);
  lines.push(`Material: ${input.material_name}`);
  lines.push(`Product URL on file: ${input.product_url}`);
  lines.push(`Baseline price: ${input.baseline_price ?? "unknown"}`);
  lines.push(`Baseline pack size: ${input.case_size ?? "?"} ${input.unit ?? ""}`.trim());
  lines.push("");
  lines.push(
    input.enumerate_sellers
      ? "This URL is suspected to be an aggregator index page. If it is, list the individual sellers on it (see AGGREGATOR INDEX PAGE); if it is one seller's own listing, re-check its price normally. Return the JSON."
      : "Re-check the current public price and return the JSON.",
  );
  return lines.join("\n");
}

export async function recheckMarketplaceQuote(input: RecheckInput): Promise<RecheckResult> {
  const res = await anthropic().beta.messages.create({
    model: input.model ?? MODEL,
    max_tokens: input.enumerate_sellers ? MAX_OUTPUT_TOKENS_ENUM : MAX_OUTPUT_TOKENS,
    betas: [WEB_FETCH_BETA],
    system: input.enumerate_sellers ? SYSTEM_PROMPT + INDEX_PAGE_RULES : SYSTEM_PROMPT,
    tools: [
      // Read the actual product page (Ben's algorithm) — the highest-yield signal.
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: MAX_FETCH_USES } as any,
      // Repair dead / wrong / gated URLs and find the correct product page.
      { type: "web_search_20260209", name: "web_search", max_uses: MAX_WEB_USES } as any,
    ],
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });
  const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
  let parsed: any;
  try {
    parsed = extractJson(text);
  } catch {
    return {
      classification: "needs_review",
      market_kind: aggregatorNameOf(input.product_url) ? "aggregator" : "marketplace",
      aggregator: aggregatorNameOf(input.product_url),
      current_price: null,
      currency: null,
      pack_size: null,
      unit_price: null,
      tiers: [],
      moq: null,
      lead_time: null,
      shipping: null,
      source_url: input.product_url,
      source_citations: [],
      notes: `Model returned no JSON: ${text.slice(0, 200)}`,
      index_page: false,
      sellers: [],
      infra_failure: true,
    };
  }

  const cls = parsed.classification;
  const validCls =
    cls === "current_price_found" || cls === "link_broken" || cls === "needs_review" || cls === "login_required" || cls === "not_marketplace"
      ? cls
      : cls === "aggregator"
      ? "current_price_found" // aggregator is a market kind, not a pull outcome — see below
      : "needs_review";

  let price: number | null = null;
  if (typeof parsed.current_price === "number" && Number.isFinite(parsed.current_price)) {
    price = parsed.current_price;
  } else if (typeof parsed.current_price === "string") {
    const cleaned = parsed.current_price.replace(/[^0-9.\-]/g, "");
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) price = n;
  }

  const toNum = (v: any): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const tiers: PriceTier[] = Array.isArray(parsed.tiers)
    ? parsed.tiers
        .filter((t: any) => t && typeof t === "object")
        .map((t: any) => ({
          pack_size: typeof t.pack_size === "string" ? t.pack_size : null,
          price: toNum(t.price),
          unit_price: toNum(t.unit_price),
        }))
        .slice(0, 20)
    : [];

  const currency = typeof parsed.currency === "string" && /^[A-Za-z]{3}$/.test(parsed.currency.trim())
    ? parsed.currency.trim().toUpperCase()
    : null;

  // Sellers read off an index page. Each must be a named company with its own
  // link: anything that echoes the platform's name, repeats the index URL, or
  // has no usable URL is dropped rather than staged as a lead.
  const sellers: AggregatorSeller[] = [];
  if (input.enumerate_sellers && Array.isArray(parsed.sellers)) {
    const indexPlatform = aggregatorNameOf(input.product_url);
    const seenUrls = new Set<string>([input.product_url.trim()]);
    for (const s of parsed.sellers) {
      if (!s || typeof s !== "object") continue;
      const name = typeof s.supplier_name === "string" ? s.supplier_name.trim() : "";
      const rawUrl = typeof s.product_url === "string" ? s.product_url.trim() : "";
      if (!name || !rawUrl) continue;
      if (isAggregatorPlatformName(name, input.material_name)) continue;
      let url: string;
      try {
        url = new URL(rawUrl).toString();
      } catch {
        continue;
      }
      if (seenUrls.has(url)) continue;
      // A seller read off an Alibaba page must live on Alibaba: when the reader
      // wanders off-platform it is no longer reading this index page's roster.
      if (indexPlatform && aggregatorNameOf(url) !== indexPlatform) continue;
      // ...and it must be that seller's own page, not another category listing.
      if (isAggregatorIndexUrl(url)) continue;
      seenUrls.add(url);
      sellers.push({
        supplier_name: name,
        product_url: url,
        country: typeof s.country === "string" && s.country.trim() ? s.country.trim() : null,
        price: toNum(s.price),
        currency: typeof s.currency === "string" && /^[A-Za-z]{3}$/.test(s.currency.trim()) ? s.currency.trim().toUpperCase() : null,
        pack_size: typeof s.pack_size === "string" && s.pack_size.trim() ? s.pack_size.trim() : null,
        moq: typeof s.moq === "string" && s.moq.trim() ? s.moq.trim() : null,
      });
      if (sellers.length >= 8) break;
    }
  }
  const indexPage = input.enumerate_sellers === true && (parsed.index_page === true || sellers.length > 0);

  const readUrl = typeof parsed.source_url === "string" ? parsed.source_url : input.product_url;
  // The curated host list is authoritative over the model's read: on a known
  // aggregator, inquiry-only ordering is the expected shape, so a "no checkout"
  // verdict must not blank a number we successfully read. The model's own
  // "aggregator" verdict covers platforms not yet on the list.
  const aggregatorName = aggregatorNameOf(readUrl) ?? aggregatorNameOf(input.product_url);
  const isAggregator = aggregatorName != null || cls === "aggregator";

  // A listing with a visible price but no checkout is NOT a marketplace price —
  // never publish its number. Force the price fields empty so nothing downstream
  // can treat it as a marketplace quote (see the checkout rule in SYSTEM_PROMPT).
  // An index page is blanked for the same reason: its numbers belong to a dozen
  // different sellers, so none of them is this lead's price.
  const isNotMarketplace = (validCls === "not_marketplace" && !isAggregator) || indexPage;
  const classification = isAggregator && validCls === "not_marketplace"
    ? (price != null ? "current_price_found" : "needs_review")
    : validCls;

  return {
    classification,
    market_kind: isAggregator ? "aggregator" : "marketplace",
    aggregator: isAggregator ? (aggregatorName ?? hostnameOf(readUrl)) : null,
    current_price: isNotMarketplace ? null : price,
    currency: isNotMarketplace ? null : currency,
    pack_size: isNotMarketplace ? null : (typeof parsed.pack_size === "string" ? parsed.pack_size : null),
    unit_price: isNotMarketplace ? null : toNum(parsed.unit_price),
    tiers: isNotMarketplace ? [] : tiers,
    moq: !indexPage && typeof parsed.moq === "string" && parsed.moq.trim() ? parsed.moq.trim() : null,
    lead_time: !indexPage && typeof parsed.lead_time === "string" && parsed.lead_time.trim() ? parsed.lead_time.trim() : null,
    shipping: !indexPage && typeof parsed.shipping === "string" && parsed.shipping.trim() ? parsed.shipping.trim() : null,
    source_url: typeof parsed.source_url === "string" ? parsed.source_url : input.product_url,
    source_citations: Array.isArray(parsed.source_citations)
      ? parsed.source_citations.filter((u: any) => typeof u === "string").slice(0, 8)
      : [],
    notes: typeof parsed.notes === "string" ? parsed.notes : null,
    index_page: indexPage,
    sellers,
  };
}
