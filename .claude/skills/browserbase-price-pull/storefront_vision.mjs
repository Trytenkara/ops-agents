// CLI: read a supplier's OWN published contact info off a marketplace/aggregator
// storefront that only renders under JS (Alibaba, IndiaMART, made-in-china, etc.).
// Many suppliers bake their real off-platform email / WhatsApp into the store
// banner image, so no text/DOM scraper can see it. We render the page in a
// proxied Browserbase session, screenshot the hero band, and ask a vision model
// to read the contact block. Prints ONE JSON object to stdout; session view URLs
// go to stderr. Validation of "is this a real corporate domain" is the caller's job.
//
//   node storefront_vision.mjs --url <storefront_url> [--supplier "..."]
import Anthropic from "@anthropic-ai/sdk";
import { openSession } from "./src/session.mjs";

const MODEL = process.env.BROWSERBASE_EXTRACT_MODEL || "claude-sonnet-5";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = arg("url");
const supplier = arg("supplier") ?? "";
if (!url) {
  console.error("usage: node storefront_vision.mjs --url <storefront_url> [--supplier ..]");
  process.exit(1);
}

const SYSTEM = `You are shown a screenshot of a supplier's storefront on a B2B marketplace (Alibaba, IndiaMART, Made-in-China, etc.).
Suppliers often publish their OWN direct contact details (email, WhatsApp, phone, contact person) as text inside the store banner/header, because the marketplace hides direct contact behind an inquiry form.
Read ONLY what is literally printed in the image. Return STRICT JSON, no prose:
{"email":string|null,"phone":string|null,"whatsapp":string|null,"name":string|null,"notes":string}
Rules:
- email: the supplier's own email exactly as printed. Do NOT return a marketplace address (anything @alibaba, @indiamart, @made-in-china, @globalsources, etc.), a placeholder, or an obviously fake sample. null if none is printed.
- phone / whatsapp: digits as printed (keep the country code). null if absent.
- name: a named contact person if one is printed (e.g. "Contact: Victoria"). null otherwise.
- Never guess, complete, or invent any character of an email or number. If it is blurry or partial, put what you can read in notes and set the field null.`;

function anthropicClient() {
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

const EMPTY = { email: null, phone: null, whatsapp: null, name: null, notes: "" };

async function grabHeroScreenshot(page) {
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  // Storefront banners are JS-injected; give the hero time to hydrate.
  for (let i = 0; i < 4; i++) {
    const imgs = await page.evaluate(() => document.images?.length ?? 0).catch(() => 0);
    if (imgs > 3) break;
    await page.waitForTimeout(2000);
  }
  // Capture the top band at near-native resolution. The vision API downscales
  // the longest side to ~1568px, so a ~1440x1600 clip keeps banner text legible
  // (a full-page shot of a tall storefront would shrink the text into mush).
  const clipH = await page.evaluate(() => Math.min(document.body?.scrollHeight ?? 1600, 1600)).catch(() => 1600);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: clipH }, type: "png" });
  return { png, status: resp?.status() ?? null };
}

async function run() {
  const s = await openSession({});
  console.error(`storefront_vision session ${s.viewUrl}`);
  try {
    await s.page.setViewportSize({ width: 1440, height: 1600 }).catch(() => {});
    const { png } = await grabHeroScreenshot(s.page);
    const anthropic = anthropicClient();
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
            { type: "text", text: `Supplier (for context only): ${supplier || "(unknown)"}. Read the printed contact block.` },
          ],
        },
      ],
    });
    const raw = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ...EMPTY, notes: "model returned no JSON" };
    try {
      const parsed = JSON.parse(m[0]);
      return { ...EMPTY, ...parsed };
    } catch {
      return { ...EMPTY, notes: "unparseable JSON" };
    }
  } finally {
    await s.browser.close().catch(() => {});
  }
}

run()
  .then((out) => console.log(JSON.stringify(out)))
  .catch((e) => {
    console.log(JSON.stringify({ ...EMPTY, notes: `vision failed: ${e?.message ?? e}` }));
    process.exit(0);
  });
