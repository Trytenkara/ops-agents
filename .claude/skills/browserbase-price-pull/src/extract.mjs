// Turn a logged-in product page into structured pricing. We read the rendered
// page text (post-login, so paywalled prices are visible) and ask Claude to
// pull the price ladder in the same shape Agent 05 already uses, so the result
// slots straight into leads_in_flight.payload.marketplace_pull / price_tiers.
import Anthropic from "@anthropic-ai/sdk";

// Reading a rendered price page is a light extraction task, so default to the
// cheaper Sonnet tier (same model Agent 05's web_search recheck uses) to keep
// the scheduled batch low-cost. Override with BROWSERBASE_EXTRACT_MODEL.
const MODEL = process.env.BROWSERBASE_EXTRACT_MODEL || "claude-sonnet-5";

const SYSTEM = `You extract wholesale/list pricing for a specific material from marketplace product-page text (the user is already logged in, so member/wholesale prices may be visible).
Return STRICT JSON only, no prose:
{"classification":"current_price_found|needs_review|login_required|link_broken","current_price":number|null,"currency":string|null,"pack_size":string|null,"unit_price":number|null,"tiers":[{"pack_size":string,"price":number,"unit_price":number|null}],"notes":string}
Rules:
- current_price_found only when a concrete numeric price for THIS material is visible.
- login_required if the page still shows a sign-in / "request access" wall.
- link_broken if it's a 404 / dead / empty product page.
- needs_review for ambiguous cases (RFQ-only, multiple SKUs, pack-size mismatch). Explain in notes.
- Never fabricate a number.`;

function anthropicClient() {
  // In this container LLM billing runs through the Gamut platform proxy
  // (ANTHROPIC_BASE_URL + bearer ANTHROPIC_AUTH_TOKEN + X-Superagent-* headers).
  // Use it when present; otherwise fall back to a direct api.anthropic.com key.
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (baseURL && authToken) {
    const defaultHeaders = {};
    for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) defaultHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return new Anthropic({ authToken, apiKey: null, baseURL, defaultHeaders });
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no Anthropic credentials (ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY)");
  return new Anthropic({ apiKey: key, baseURL: "https://api.anthropic.com" });
}

export async function extractPricing({ page, supplier, material }) {
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 14000) ?? "");
  const anthropic = anthropicClient();
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [
      { role: "user", content: `Supplier: ${supplier || "(unknown)"}\nMaterial: ${material || "(unknown)"}\n\nPAGE TEXT:\n${text}` },
    ],
  });
  const raw = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { classification: "needs_review", current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], notes: "model returned no JSON" };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { classification: "needs_review", current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], notes: "unparseable JSON" };
  }
}
