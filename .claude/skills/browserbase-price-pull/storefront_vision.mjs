// CLI: read a supplier's OWN published contact info off a marketplace/aggregator
// storefront that only renders under JS (Alibaba, IndiaMART, made-in-china, etc.).
// These pages serve an empty shell to a plain fetch, so a browser render is the
// only way in. Once rendered, contact details sit in one of three places, so we
// climb a ladder and stop at the first that answers:
//
//   dom    - mailto:/tel: links and page text. One page.evaluate, no model call.
//   text   - the same text read by a cheap model, for the layouts and languages
//            a pattern list was never written for.
//   vision - a screenshot of the hero band, for the residual case this file was
//            built for: suppliers who bake their real email / WhatsApp into the
//            store banner GRAPHIC because the marketplace hides direct contact.
//
// Only the last rung needs pixels, and it is the one worth avoiding: the render
// is already paid for by the time we read, so text costs almost nothing. `source`
// reports which rung produced the email, which is how the mix between
// published-as-text and baked-into-the-banner gets measured from ordinary runs.
//
// Prints ONE JSON object to stdout; session view URLs go to stderr. Validation of
// "is this a real corporate domain" is the caller's job.
//
//   node storefront_vision.mjs --url <storefront_url> [--supplier "..."]
import Anthropic from "@anthropic-ai/sdk";
import { openSession } from "./src/session.mjs";

const VISION_MODEL = process.env.BROWSERBASE_EXTRACT_MODEL || "claude-sonnet-5";
const TEXT_MODEL = "claude-haiku-4-5";
// Wide enough for a desktop banner, tall enough to reach a contact block sitting
// under the hero. Must be requested at session create; see session.mjs.
const VIEWPORT = { width: 1440, height: 1600 };
const MAX_TEXT_CHARS = 12000;

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

// A marketplace relay address is not the supplier's own contact, and returning
// one is worse than returning nothing because it reads as a direct channel.
const MARKETPLACE_EMAIL =
  /@(?:[a-z0-9-]+\.)*(?:alibaba|aliexpress|1688|indiamart|made-in-china|globalsources|tradeindia|ec21|exportersindia)\./i;
// Template addresses, tracker/CDN noise, and image filenames that read as an
// address once an @ lands next to them.
const JUNK_EMAIL =
  /@(?:example|test|sample|domain|yourdomain|yoursite|email|sentry|wixpress|godaddy|cloudflare)\.|\.(?:png|jpe?g|gif|webp|svg|css|js)$/i;

function usableEmail(e) {
  if (!e) return null;
  const v = String(e).trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return null;
  if (MARKETPLACE_EMAIL.test(v) || JUNK_EMAIL.test(v)) return null;
  return v;
}

const SYSTEM_TEXT = `You read contact details off a supplier's storefront page on a B2B marketplace. You copy, you do not infer.
Return ONLY a JSON object, no prose:
{"email":string|null,"phone":string|null,"whatsapp":string|null,"name":string|null,"notes":string}
Rules:
- Copy values exactly as printed. Keep the country code on any number.
- Any format, separator or language counts (Tel, Tel., Telefon, WhatsApp, Contact, 电话, 联系人).
- email must be the supplier's OWN address. Never return a marketplace address (@alibaba, @indiamart, @made-in-china, @globalsources and the like), a placeholder, or a sample.
- name is a specific human named on the page. A department, the company name, or a page label is NOT a name.
- Never construct an address from a name and a domain. Never guess a character.
- A value you cannot see is null.`;

const SYSTEM_VISION = `You are shown a screenshot of a supplier's storefront on a B2B marketplace (Alibaba, IndiaMART, Made-in-China, etc.).
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

// Earlier rungs are the more literal readers, so a later one may only fill a gap,
// never overwrite what an earlier one already read.
function fillGaps(into, from) {
  if (!from) return into;
  for (const k of ["email", "phone", "whatsapp", "name"]) {
    if (into[k] == null && from[k] != null) into[k] = from[k];
  }
  if (from.notes) into.notes = into.notes ? `${into.notes}; ${from.notes}` : from.notes;
  return into;
}

function parseJsonReply(res) {
  const raw = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { ...EMPTY, notes: "model returned no JSON" };
  try {
    return { ...EMPTY, ...JSON.parse(m[0]) };
  } catch {
    return { ...EMPTY, notes: "unparseable JSON" };
  }
}

async function settle(page) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  // Storefront banners and contact blocks are JS-injected; give them time to
  // hydrate before reading either the text or the pixels.
  for (let i = 0; i < 4; i++) {
    const imgs = await page.evaluate(() => document.images?.length ?? 0).catch(() => 0);
    if (imgs > 3) break;
    await page.waitForTimeout(2000);
  }
}

// The rendered DOM, which is the thing a plain fetch of these pages cannot get.
async function readDom(page, limit) {
  return page
    .evaluate((max) => {
      const attr = (sel, name) =>
        Array.from(document.querySelectorAll(sel))
          .map((el) => el.getAttribute(name) ?? "")
          .filter(Boolean);
      return {
        text: (document.body?.innerText ?? "").slice(0, max),
        mailtos: attr('a[href^="mailto:"]', "href"),
        tels: attr('a[href^="tel:"]', "href"),
        // Banner text is sometimes duplicated into alt text for accessibility,
        // which turns what looks like a vision-only read into a free one.
        alts: attr("img[alt]", "alt"),
      };
    }, limit)
    .catch(() => null);
}

function fromDom(dom) {
  if (!dom) return null;
  const haystack = [dom.text, ...dom.alts].join("\n");
  const email =
    dom.mailtos.map(usableEmail).find(Boolean) ??
    (haystack.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map(usableEmail).find(Boolean) ??
    null;
  const phone = dom.tels.map((h) => h.replace(/^tel:/, "").trim()).find(Boolean) ?? null;
  return email || phone ? { ...EMPTY, email, phone } : null;
}

async function readText(anthropic, dom) {
  const body = [dom.text, ...dom.alts].join("\n").slice(0, MAX_TEXT_CHARS).trim();
  if (!body) return null;
  const res = await anthropic.messages.create({
    model: TEXT_MODEL,
    max_tokens: 400,
    system: SYSTEM_TEXT,
    messages: [
      { role: "user", content: `Supplier (for context only): ${supplier || "(unknown)"}.\n\nPage text:\n${body}` },
    ],
  });
  return parseJsonReply(res);
}

async function readVision(anthropic, page) {
  // Capture the top band rather than the whole page. The vision API downscales
  // the longest side to ~1568px, so a full-page shot of a tall storefront would
  // shrink the banner text into mush.
  const clipH = await page
    .evaluate((h) => Math.min(document.body?.scrollHeight ?? h, h), VIEWPORT.height)
    .catch(() => VIEWPORT.height);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: VIEWPORT.width, height: clipH }, type: "png" });
  const res = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 512,
    system: SYSTEM_VISION,
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
  return parseJsonReply(res);
}

async function run() {
  const s = await openSession({ viewport: VIEWPORT });
  console.error(`storefront_vision session ${s.viewUrl}`);
  try {
    await settle(s.page);
    const dom = await readDom(s.page, MAX_TEXT_CHARS);

    const found = { ...EMPTY };
    let source = null;

    // A model told not to return a marketplace address still sometimes does, so
    // every rung's email goes through the same check the DOM rung uses.
    const clean = (r) => (r ? { ...r, email: usableEmail(r.email) } : r);

    fillGaps(found, fromDom(dom));
    if (found.email) source = "dom";

    // The email is the actionable channel, so it alone decides whether to spend
    // the next rung. A phone picked up on the way is kept either way.
    const anthropic = anthropicClient();
    if (!found.email && dom) {
      fillGaps(found, clean(await readText(anthropic, dom)));
      if (found.email) source = "text";
    }
    if (!found.email) {
      fillGaps(found, clean(await readVision(anthropic, s.page)));
      if (found.email) source = "vision";
    }

    return { ...found, source };
  } finally {
    await s.browser.close().catch(() => {});
  }
}

run()
  .then((out) => console.log(JSON.stringify(out)))
  .catch((e) => {
    console.log(JSON.stringify({ ...EMPTY, source: null, notes: `storefront read failed: ${e?.message ?? e}` }));
    process.exit(0);
  });
