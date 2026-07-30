// Agentic price pull (Stagehand on Browserbase).
//
// The passive path (pull.mjs / batch.mjs fetch+extract) only reads whatever text
// happens to be on the landing URL. Most marketplace leads point at a supplier
// ROOT domain, so there's nothing to extract and the lead comes back needs_review
// even when the price is one search away. This path drives the page like a person:
// close popups, use the site search, try material-name variants, open the matching
// product, THEN extract the price ladder.
//
// Built on Stagehand (Browserbase's own agent framework) so it runs on the exact
// same proxied cloud sessions we already use. Inference uses the Browserbase Model
// Router (model:"auto") — billed on BROWSERBASE_API_KEY, no provider key needed.
//
// Returns the SAME shape as extract.mjs' extractPricing so writePull() is a drop-in.
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { extractPricing } from "./extract.mjs";

// Navigation model for the Stagehand agent. "auto" = Browserbase Model Router
// (billed on BROWSERBASE_API_KEY, no provider key, cheapest per call).
const NAV_MODEL = process.env.BROWSERBASE_STAGEHAND_MODEL || "auto";

// "Cocamidopropyl Betaine (CAPB)" -> ["Cocamidopropyl Betaine (CAPB)", "Cocamidopropyl Betaine", "CAPB"]
// so the agent can retry the site search with the common name and the acronym.
export function materialVariants(material) {
  const out = [];
  const seen = new Set();
  const add = (s) => {
    const v = (s || "").trim();
    if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  };
  const full = (material || "").trim();
  add(full);
  const paren = full.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren) { add(paren[1]); add(paren[2]); }
  return out;
}

// Never let the model invent a price: if extraction claims current_price_found but
// carries no numeric price, downgrade to needs_review (fleet rule: unreadable price
// -> flag, never a guessed number).
function guard(result, { sourceUrl }) {
  const out = { ...result, source_url: sourceUrl };
  if (out.classification === "current_price_found" && out.current_price == null) {
    out.classification = "needs_review";
  }
  return out;
}

function navInstruction({ material, supplier, variants }) {
  return [
    `Goal: find the list / wholesale price for the material "${material}" from supplier "${supplier}" on this website.`,
    `You START on the target URL. If it is already the product page for this material, the price is almost certainly HERE — do NOT navigate away or search; work with this page.`,
    `1. If a popup/modal/cookie banner/newsletter box/promo overlay/chat widget covers the page, close it by clicking ONLY its close / X / "No thanks" / "Reject" / "Maybe later" control (or "Accept cookies" for a cookie banner). NEVER click a Subscribe / Sign up / Submit / Continue button and NEVER type into a popup — that navigates away.`,
    `2. If a price for this material is visible on the current page, capture it. Prefer this over searching.`,
    `3. ONLY if the material or its price is not on the current page: find the site's search box, type the material, and submit. Try these terms until product results appear: ${variants.map((v) => `"${v}"`).join(", ")}. Then open the product page that best matches "${material}".`,
    `4. IMPORTANT — capture EVERY pack size: if the product has a size / quantity / variant selector (e.g. 16 oz, 1 Gallon, 25 kg, drum), click through EACH option one at a time and read the price that appears for that option, so you record the full price ladder — not just a price range.`,
    `HARD RULES: Do NOT log in, register, or create an account. Do NOT submit any "request a quote" / RFQ / "contact supplier" / newsletter / sample-request form, and do NOT enter personal information anywhere. If the price is only available behind a login or an RFQ form, simply stop — that is an acceptable, expected outcome.`,
  ].join("\n");
}

// Deterministic popup sweep BEFORE the agent navigates. On sites like Lori the
// agent got stuck fighting an entry modal instead of navigating; clearing it up
// front (Escape + a semantic close, repeated for stacked cookie+newsletter combos)
// frees the agent to actually search and click into products.
async function pressEscape(page) {
  try {
    await page.keyboard?.press?.("Escape");
  } catch {
    /* Stagehand page may not expose keyboard; the semantic close covers it */
  }
}

async function dismissPopups(stagehand, page, onStep) {
  await pressEscape(page);
  for (let i = 0; i < 3; i++) {
    let r;
    try {
      r = await stagehand.act(
        "If a popup, modal dialog, cookie consent banner, newsletter/subscribe box, promo overlay, or chat widget is covering the page, dismiss it in ONE click using the fastest whole-banner control: prefer 'Reject all' / 'Accept all' / 'Close' / the X / 'No thanks' / 'Maybe later'. Do NOT click 'Manage preferences', 'Customize', 'Settings', or 'Save preferences' (those open more dialogs). Do NOT click any Subscribe, Sign up, Submit, or Continue button and do NOT type into any field. If nothing is covering the page, do nothing.",
      );
    } catch {
      break;
    }
    if (onStep) onStep({ step: `popup-sweep ${i + 1}`, action: `${r?.success ? "closed" : "none"}: ${r?.actionDescription ?? r?.message ?? ""}`.slice(0, 120) });
    if (!r?.success) break;
    await page.waitForTimeout(600);
    await pressEscape(page);
  }
}

// Deterministic per-size price sweep. The agent lands us on the product page; an
// LLM agent shouldn't be trusted to READ the numbers (it rounds/paraphrases), so we
// drive the size selector ourselves: enumerate the size options, select each one,
// and read the single price the page then renders with the proven extractor. This
// turns a "$5.99 - $23.99" range into a real per-size ladder.
function cleanSizeLabel(s) {
  const t = (s || "").trim();
  const m = t.match(/\d+(?:\.\d+)?\s?(?:oz|ounces?|lb|pounds?|kg|kilograms?|g\b|grams?|ml|l\b|liters?|litres?|gal|gallons?|drum|pail|tote)/i);
  if (m) return m[0].replace(/\s+/g, " ").trim();
  if (/gallon/i.test(t)) return "Gallon";
  const tail = t.split(/[-–—:]/).pop().trim();
  return tail || t;
}

// Read the single price currently displayed for the selected variant. Scoped
// (not whole-page) so it picks up the value that just changed on selection.
async function readSelectedPrice(stagehand) {
  try {
    const r = await stagehand.extract(
      "the single product price CURRENTLY displayed for the size/variant that is selected right now (the main active price shown on the page this moment, not a list of other sizes, not a struck-through original price). Return just the number.",
      z.object({ price: z.number().nullable() }),
    );
    return r?.price ?? (typeof r === "number" ? r : null);
  } catch {
    return null;
  }
}

const SIZE_RE = /\d\s?(?:oz|ounces?|ml|l\b|liters?|litres?|gal|gallons?|lb|lbs|pounds?|kg|kilograms?|g\b|grams?|drum|pail|tote)/i;

// Only trust a ladder if selecting different sizes yields DIFFERENT prices. If every
// size reads the same number, selection isn't moving the price (static range) — bail
// so the caller falls back to the honest range/needs_review rather than invent a map.
function finalizeTiers(tiers, onStep) {
  const distinct = new Set(tiers.map((t) => t.price));
  if (tiers.length >= 2 && distinct.size < 2) {
    if (onStep) onStep({ step: "size-sweep", action: `discarded — price did not vary across ${tiers.length} sizes (static range, not per-size)` });
    return null;
  }
  return tiers.length ? tiers : null;
}

// PATH A — native <select> size dropdown. A <select> needs a real 'change' event to
// recompute the price; Stagehand's DOM act sets the value without firing it (that's
// why MakingCosmetics read $790 for every size). We set value + dispatch input/change
// ourselves, then read the price the site renders.
async function sweepSelect(stagehand, page, onStep) {
  const meta = await page
    .evaluate((reSrc) => {
      const re = new RegExp(reSrc, "i");
      const sels = [...document.querySelectorAll("select")];
      const idx = sels.findIndex((s) => [...s.options].filter((o) => re.test(o.text)).length >= 2);
      if (idx < 0) return null;
      return { idx, options: [...sels[idx].options].map((o) => ({ text: o.text.trim(), value: o.value })) };
    }, SIZE_RE.source)
    .catch(() => null);
  if (!meta) return null;

  const tiers = [];
  const seen = new Set();
  for (const o of meta.options) {
    if (!o.text || /^\s*(select|choose|please|--)/i.test(o.text)) continue; // placeholder
    await page.evaluate(
      ({ idx, value }) => {
        const s = document.querySelectorAll("select")[idx];
        if (!s) return;
        s.value = value;
        s.dispatchEvent(new Event("input", { bubbles: true }));
        s.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { idx: meta.idx, value: o.value },
    );
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const price = await readSelectedPrice(stagehand);
    const pack = cleanSizeLabel(o.text);
    if (price != null && !seen.has(pack)) {
      seen.add(pack);
      tiers.push({ pack_size: pack, price, unit_price: null });
      if (onStep) onStep({ step: "size-sweep", action: `${pack} → ${price}` });
    }
  }
  return finalizeTiers(tiers, onStep);
}

// PATH B — non-<select> variants (radio buttons, swatch/pill links, Shopify variant
// buttons). Enumerate them semantically and click each, reading the price after.
async function sweepObserve(stagehand, page, onStep) {
  let opts = [];
  try {
    opts = await stagehand.observe(
      "each individual selectable pack-size / quantity / variant option for this product (the distinct size choices such as '16 oz', '1 Gallon', '25 kg', '5 lb') — NOT the add-to-cart button, NOT quantity steppers",
    );
  } catch {
    return null;
  }
  if (!Array.isArray(opts) || opts.length < 2) return null;

  const tiers = [];
  const seen = new Set();
  for (const opt of opts.slice(0, 8)) {
    try {
      await stagehand.act(opt);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const price = await readSelectedPrice(stagehand);
      const pack = cleanSizeLabel(opt.description);
      if (price != null && !seen.has(pack)) {
        seen.add(pack);
        tiers.push({ pack_size: pack, price, unit_price: null });
        if (onStep) onStep({ step: "size-sweep", action: `${pack} → ${price}` });
      }
    } catch {
      /* one size failed — skip it, keep the rest */
    }
  }
  return finalizeTiers(tiers, onStep);
}

// Resolve a real per-size ladder: try the deterministic <select> path first, then
// the semantic observe/click path for other variant UIs.
async function sizeSweep(stagehand, page, { onStep }) {
  const bySelect = await sweepSelect(stagehand, page, onStep).catch(() => null);
  if (bySelect && bySelect.length) return bySelect;
  return await sweepObserve(stagehand, page, onStep).catch(() => null);
}

// Click with recovery. Stagehand's "error performing click" is almost always a
// popup/overlay intercepting the target, so on failure we re-dismiss popups and
// retry with a short backoff (the observed no-click-through failure mode).
async function actWithRetry(stagehand, page, action, { tries = 3, onStep } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      const r = await stagehand.act(action);
      if (r?.success !== false) return r;
    } catch (e) {
      if (onStep) onStep({ step: "act-retry", action: `try ${i + 1} failed: ${String(e?.message ?? e).slice(0, 80)}` });
    }
    await dismissPopups(stagehand, page, onStep); // a popup likely intercepted the click
    await page.waitForTimeout(700 * (i + 1));
  }
  return null;
}

// Deterministic search→result→click-through. When the current page has no price
// (a search-results / category / root page), find the product-result link that
// matches the material and click into it — instead of relying on the LLM agent,
// whose clicks were failing. Returns true if it navigated somewhere new.
async function clickThroughToProduct(stagehand, page, { material, variants, onStep }) {
  const names = (variants && variants.length ? variants : [material]).filter(Boolean);
  const before = page.url();
  let links = [];
  try {
    links = await stagehand.observe(
      `the product-result link that opens an individual product page for "${names[0]}"` +
        (names.length > 1 ? ` (also called ${names.slice(1).join(", ")})` : "") +
        `: the clickable product title/link in the search results or category listing. NOT ads, NOT the nav menu, NOT "add to cart", NOT pagination, NOT category headers.`,
    );
  } catch {
    links = [];
  }
  if (!Array.isArray(links) || !links.length) {
    if (onStep) onStep({ step: "click-through", action: "no matching product link observed" });
    return false;
  }
  await actWithRetry(stagehand, page, links[0], { onStep });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const moved = page.url() !== before;
  if (onStep) onStep({ step: "click-through", action: `${moved ? "opened" : "no-nav"}: ${(links[0].description || "").slice(0, 80)}` });
  return moved;
}

// One attempt in one fresh proxied Stagehand session.
async function attempt({ url, material, supplier, maxSteps, onSession, onStep }) {
  const variants = materialVariants(material);
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    model: NAV_MODEL,
    verbose: 0,
    // Route Stagehand's own logs to stderr so they never corrupt stdout, which
    // pull-agentic.mjs prints the result JSON to (a stray error log otherwise
    // makes the JSON unparseable).
    logger: (line) => {
      try {
        console.error("[sh]", typeof line === "string" ? line : line?.message ?? JSON.stringify(line));
      } catch {
        /* ignore logger failures */
      }
    },
    browserbaseSessionCreateParams: {
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      proxies: true,
      // Cap the session server-side so a stuck pull self-terminates well before the
      // project's 600s default (which produced TIMED_OUT sessions hogging a slot).
      timeout: Number(process.env.BB_SESSION_TIMEOUT_SEC) || 240,
      browserSettings: { solveCaptchas: true, viewport: { width: 1288, height: 711 } },
    },
  });
  await stagehand.init();
  const sessionId = stagehand.sessionId;
  const viewUrl = `https://browserbase.com/sessions/${sessionId}`;
  if (onSession) onSession({ viewUrl, sessionId });
  try {
    const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
    let resp;
    try {
      resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      // Nav crashed/refused/timed out — transient (proxy/DNS). Retry on a fresh IP.
      throw Object.assign(new Error(`navigation failed: ${String(e?.message ?? e).slice(0, 100)}`), { retry: true });
    }
    const status = resp?.status?.() ?? 0;
    if (status === 403 || status === 429 || status === 503) {
      const err = new Error(`blocked (status ${status})`);
      err.ban = true;
      throw err;
    }
    if (status === 404 || status === 410 || status === 451) {
      // Dead URL — an agent can't recover a 404; classify and stop (no retry).
      return { ...guard({ classification: "link_broken", current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], notes: `HTTP ${status} — dead listing URL.` }, { sourceUrl: url }), viewUrl, sessionId };
    }
    if (!resp || status === 0) {
      throw Object.assign(new Error("navigation returned no response"), { retry: true });
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    // Blank/black-screen render (the 2–3s dead sessions Ben saw): the page loaded
    // essentially no text. Usually a transient proxy hiccup — retry on a fresh IP.
    let initLen = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);
    if (initLen < 50) {
      await page.waitForTimeout(2500); // give a late-painting SPA a beat
      initLen = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);
      if (initLen < 50) throw Object.assign(new Error("blank page after load"), { retry: true });
    }

    // Clear any entry popup up front so we can read/navigate the real page.
    await dismissPopups(stagehand, page, onStep);

    // Read the current page's price ladder with the proven innerText+Claude
    // extractor (same shape Agent 05 / writePull expect; it handled variant price
    // mapping well where Stagehand's accessibility-tree extract did not).
    const readPrice = async () => {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 3; i++) {
        const len = await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => 0);
        if (len > 200) break;
        await page.waitForTimeout(2000);
      }
      return extractPricing({ page, supplier, material });
    };
    const hasPrice = (p) => p?.classification === "current_price_found" && p?.current_price != null;

    let trace = [];
    let navMessage = null;

    // 1) The price may already be on the landing page (direct product URLs).
    let price = await readPrice();

    // 2) If not, let the Stagehand agent drive (search + navigate) for odd layouts.
    if (!hasPrice(price)) {
      const agent = stagehand.agent();
      const nav = await agent
        .execute({ instruction: navInstruction({ material, supplier, variants }), maxSteps })
        .catch((e) => ({ success: false, message: String(e?.message ?? e).slice(0, 200), actions: [] }));
      navMessage = nav?.message ?? null;
      trace = (nav?.actions ?? []).map((a) => ({ type: a.type, action: a.action ?? a.reasoning ?? undefined, url: a.pageUrl }));
      if (onStep) for (const t of trace) onStep(t);
      price = await readPrice();
    }

    // 3) Still nothing → deterministic search-result click-through (the agent's own
    //    clicks were the failure mode), then re-read.
    if (!hasPrice(price)) {
      const moved = await clickThroughToProduct(stagehand, page, { material, variants, onStep }).catch(() => false);
      if (moved) price = await readPrice();
    }

    // If the page has a multi-size selector, drive it ourselves to resolve a real
    // per-size ladder (beats the ambiguous price range the whole-page read returns).
    const swept = await sizeSweep(stagehand, page, { supplier, material, onStep }).catch(() => null);
    if (swept && swept.length) {
      const first = swept[0];
      const result = guard(
        {
          classification: "current_price_found",
          current_price: first.price,
          currency: price.currency ?? "USD",
          pack_size: first.pack_size,
          unit_price: first.unit_price ?? null,
          tiers: swept,
          notes: `Per-size ladder resolved by selecting each option (${swept.length} size(s)).`,
        },
        { sourceUrl: page.url() },
      );
      return { ...result, viewUrl, sessionId, navMessage, navTrace: trace };
    }

    const result = guard(price, { sourceUrl: page.url() });
    return { ...result, viewUrl, sessionId, navMessage, navTrace: trace };
  } finally {
    await stagehand.close().catch(() => {});
  }
}

const isRateLimit = (msg) => /\b429\b|rate.?limit|too many requests/i.test(msg);

// Jittered exponential backoff. Under high concurrency the 90 workers must NOT
// retry a 429 in lockstep (that just re-hits the limit), so each waits a random-
// ised, growing interval: ~3s, ~6s, ~12s (+ up to 2s jitter).
async function backoff(i) {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  const ms = 3000 * 2 ** i + Math.floor((buf[0] / 2 ** 32) * 2000);
  await new Promise((r) => setTimeout(r, ms));
}

// Public entry: agentic pull with retry. A 403/429/503, a model-router 429/rate
// limit, a blank/failed nav, or a dead session gets a fresh Stagehand session
// (new residential IP), up to maxAttempts. Rate-limit retries back off (jittered).
export async function agenticPull({ url, material, supplier, maxSteps = 15, maxAttempts = 4, onSession, onStep } = {}) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt({ url, material, supplier, maxSteps, onSession, onStep });
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      const rateLimited = isRateLimit(msg);
      const retryable = e?.ban || e?.retry || rateLimited || /Target (page|closed)|browser has been closed|session .*(closed|expired|disconnect)|websocket|CDP|Connection closed/i.test(msg);
      if (!retryable) {
        return { classification: "needs_review", current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], notes: `agentic pull error: ${msg.slice(0, 180)}`, source_url: url };
      }
      // A model-router 429 under load recovers if we wait; back off (jittered)
      // before the next fresh session so the fleet doesn't retry in lockstep.
      if (rateLimited && i < maxAttempts - 1) await backoff(i);
      // else: rotate to a fresh session/IP and retry
    }
  }
  // Exhausted retries — label honestly: a persistent 429 is a transient block
  // (recoverable next refresh), NOT a login wall.
  const msg = String(lastErr?.message ?? lastErr);
  if (isRateLimit(msg)) {
    return { classification: "needs_review", current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], notes: `rate-limited (429) after ${maxAttempts} attempts: ${msg.slice(0, 120)}`, source_url: url };
  }
  return { classification: "login_required", current_price: null, currency: null, pack_size: null, unit_price: null, tiers: [], notes: `blocked across ${maxAttempts} proxy IPs: ${msg.slice(0, 140)}`, source_url: url };
}
