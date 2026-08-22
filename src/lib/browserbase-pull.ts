// Agentic marketplace price pull: Stagehand driving a remote Browserbase
// browser. Ported from the container-side `browserbase-price-pull` skill.
//
// Agent 05 reads a page as text (web_fetch) and repairs bad URLs with
// web_search. That cannot press a size selector, so a listing whose price only
// appears after choosing "1 Gallon" reads as a range or as nothing at all, and a
// lead pointing at a supplier's ROOT domain has no price to read. This path
// drives the page like a person: dismiss popups, search the site, open the
// matching product, then sweep every size option.
//
// It is expensive (a browser session and several model calls per lead), so it is
// an escalation tier over Agent 05's residue, never the primary pull.
//
// Never fabricates: no visible numeric price means a classification of
// needs_review / login_required, never a guessed number.

import { Stagehand } from "@browserbasehq/stagehand";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { classifyFailure } from "@/lib/retry-verdict";

export interface PullTier {
  pack_size: string | null;
  price: number;
  unit_price: number | null;
}

export interface PullResult {
  classification: "current_price_found" | "needs_review" | "login_required" | "link_broken";
  current_price: number | null;
  currency: string | null;
  pack_size: string | null;
  unit_price: number | null;
  tiers: PullTier[];
  notes: string;
  source_url: string;
  viewUrl?: string;
  sessionId?: string;
  // Optional shipping cost captured from checkout (populated when capturing shipping is enabled)
  shippingCost?: number | null;
  shippingAddress?: string | null;
}

// Browserbase's Model Router: billed on BROWSERBASE_API_KEY, so navigation needs
// no provider key of its own.
const NAV_MODEL = process.env.BROWSERBASE_STAGEHAND_MODEL || "auto";
// Reading a rendered price page is light extraction, so use the same Sonnet tier
// Agent 05's recheck uses rather than paying Opus rates per lead.
const EXTRACT_MODEL = process.env.BROWSERBASE_EXTRACT_MODEL || "claude-sonnet-5";
// Cap the session server-side so a stuck pull self-terminates well before the
// project default, which otherwise leaves TIMED_OUT sessions holding a slot.
const SESSION_TIMEOUT_SEC = Number(process.env.BB_SESSION_TIMEOUT_SEC) || 240;

const EXTRACT_SYSTEM = `You extract wholesale/list pricing for a specific material from marketplace product-page text.
Return STRICT JSON only, no prose:
{"classification":"current_price_found|needs_review|login_required|link_broken","current_price":number|null,"currency":string|null,"pack_size":string|null,"unit_price":number|null,"tiers":[{"pack_size":string,"price":number,"unit_price":number|null}],"notes":string}
Rules:
- current_price_found only when a concrete numeric price for THIS material is visible.
- login_required if the page still shows a sign-in / "request access" wall.
- link_broken if it's a 404 / dead / empty product page.
- needs_review for ambiguous cases (quote-only, multiple SKUs, pack-size mismatch). Explain in notes.
- Never fabricate a number.`;

function emptyResult(
  classification: PullResult["classification"],
  notes: string,
  sourceUrl: string,
): PullResult {
  return {
    classification,
    current_price: null,
    currency: null,
    pack_size: null,
    unit_price: null,
    tiers: [],
    notes,
    source_url: sourceUrl,
  };
}

async function extractPricing(page: any, supplier: string, material: string, sourceUrl: string): Promise<PullResult> {
  const text: string = await page.evaluate(() => (document.body as any)?.innerText?.slice(0, 14000) ?? "");
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await anthropic.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 1024,
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Supplier: ${supplier || "(unknown)"}\nMaterial: ${material || "(unknown)"}\n\nPAGE TEXT:\n${text}`,
      },
    ],
  });
  const raw = res.content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return emptyResult("needs_review", "model returned no JSON", sourceUrl);
  try {
    const parsed = JSON.parse(m[0]);
    return { ...emptyResult("needs_review", "", sourceUrl), ...parsed, source_url: sourceUrl };
  } catch {
    return emptyResult("needs_review", "unparseable JSON", sourceUrl);
  }
}

// "Cocamidopropyl Betaine (CAPB)" -> the full name, the base name, and the
// acronym, so the on-site search can be retried with each.
export function materialVariants(material: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string | undefined) => {
    const v = (s || "").trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  };
  const full = (material || "").trim();
  add(full);
  const paren = full.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    add(paren[1]);
    add(paren[2]);
  }
  return out;
}

// Never let the model invent a price: a current_price_found carrying no number
// is downgraded, per the fleet rule that an unreadable price is a flag and never
// a guess.
function guard(result: PullResult, sourceUrl: string): PullResult {
  const out = { ...result, source_url: sourceUrl };
  if (out.classification === "current_price_found" && out.current_price == null) {
    out.classification = "needs_review";
  }
  return out;
}

function navInstruction(material: string, supplier: string, variants: string[]): string {
  return [
    `Goal: find the list / wholesale price for the material "${material}" from supplier "${supplier}" on this website.`,
    `You START on the target URL. If it is already the product page for this material, the price is almost certainly HERE — do NOT navigate away or search; work with this page.`,
    `1. If a popup/modal/cookie banner/newsletter box/promo overlay/chat widget covers the page, close it by clicking ONLY its close / X / "No thanks" / "Reject" / "Maybe later" control (or "Accept cookies" for a cookie banner). NEVER click a Subscribe / Sign up / Submit / Continue button and NEVER type into a popup — that navigates away.`,
    `2. If a price for this material is visible on the current page, capture it. Prefer this over searching.`,
    `3. ONLY if the material or its price is not on the current page: find the site's search box, type the material, and submit. Try these terms until product results appear: ${variants
      .map((v) => `"${v}"`)
      .join(", ")}. Then open the product page that best matches "${material}".`,
    `4. IMPORTANT — capture EVERY pack size: if the product has a size / quantity / variant selector (e.g. 16 oz, 1 Gallon, 25 kg, drum), click through EACH option one at a time and read the price that appears for that option, so you record the full price ladder — not just a price range.`,
    `HARD RULES: Do NOT log in, register, or create an account. Do NOT submit any "request a quote" / sourcing inquiry / "contact supplier" / newsletter / sample-request form, and do NOT enter personal information anywhere. If the price is only available behind a login or an inquiry form, simply stop — that is an acceptable, expected outcome.`,
  ].join("\n");
}

async function pressEscape(page: any) {
  try {
    await page.keyboard?.press?.("Escape");
  } catch {
    /* the semantic close below covers pages without a keyboard handle */
  }
}

// Sweep popups BEFORE the agent navigates: an entry modal otherwise absorbs the
// agent's whole step budget fighting it instead of finding the product.
async function dismissPopups(stagehand: any, page: any) {
  await pressEscape(page);
  for (let i = 0; i < 3; i++) {
    let r: any;
    try {
      r = await stagehand.act(
        "If a popup, modal dialog, cookie consent banner, newsletter/subscribe box, promo overlay, or chat widget is covering the page, dismiss it in ONE click using the fastest whole-banner control: prefer 'Reject all' / 'Accept all' / 'Close' / the X / 'No thanks' / 'Maybe later'. Do NOT click 'Manage preferences', 'Customize', 'Settings', or 'Save preferences' (those open more dialogs). Do NOT click any Subscribe, Sign up, Submit, or Continue button and do NOT type into any field. If nothing is covering the page, do nothing.",
      );
    } catch {
      break;
    }
    if (!r?.success) break;
    await page.waitForTimeout(600);
    await pressEscape(page);
  }
}

function cleanSizeLabel(s: string): string {
  const t = (s || "").trim();
  const m = t.match(
    /\d+(?:\.\d+)?\s?(?:oz|ounces?|lb|pounds?|kg|kilograms?|g\b|grams?|ml|l\b|liters?|litres?|gal|gallons?|drum|pail|tote)/i,
  );
  if (m) return m[0].replace(/\s+/g, " ").trim();
  if (/gallon/i.test(t)) return "Gallon";
  const tail = t.split(/[-–—:]/).pop()!.trim();
  return tail || t;
}

// Read the price displayed for the variant selected RIGHT NOW. Scoped rather
// than whole-page so it picks up the value that just changed on selection.
async function readSelectedPrice(stagehand: any): Promise<number | null> {
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

const SIZE_RE =
  /\d\s?(?:oz|ounces?|ml|l\b|liters?|litres?|gal|gallons?|lb|lbs|pounds?|kg|kilograms?|g\b|grams?|drum|pail|tote)/i;

// Only trust a ladder if selecting different sizes yields DIFFERENT prices. If
// every size reads the same number, selection is not moving the price (it is a
// static range), so bail rather than invent a per-size map.
function finalizeTiers(tiers: PullTier[]): PullTier[] | null {
  const distinct = new Set(tiers.map((t) => t.price));
  if (tiers.length >= 2 && distinct.size < 2) return null;
  return tiers.length ? tiers : null;
}

// PATH A: a native <select> size dropdown. A <select> needs a real 'change' event
// to recompute the price; setting .value through the DOM alone does not fire one,
// which is how every size once read the same number. Set value + dispatch
// input/change ourselves, then read what the site renders.
async function sweepSelect(stagehand: any, page: any): Promise<PullTier[] | null> {
  const meta = await page
    .evaluate((reSrc: string) => {
      const re = new RegExp(reSrc, "i");
      const sels = [...document.querySelectorAll("select")];
      const idx = sels.findIndex((s: any) => [...s.options].filter((o: any) => re.test(o.text)).length >= 2);
      if (idx < 0) return null;
      return {
        idx,
        options: [...(sels[idx] as any).options].map((o: any) => ({ text: o.text.trim(), value: o.value })),
      };
    }, SIZE_RE.source)
    .catch(() => null);
  if (!meta) return null;

  const tiers: PullTier[] = [];
  const seen = new Set<string>();
  for (const o of meta.options) {
    if (!o.text || /^\s*(select|choose|please|--)/i.test(o.text)) continue; // placeholder option
    await page.evaluate(
      ({ idx, value }: { idx: number; value: string }) => {
        const s = document.querySelectorAll("select")[idx] as any;
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
    }
  }
  return finalizeTiers(tiers);
}

// PATH B: non-<select> variants (radio buttons, swatch/pill links, Shopify
// variant buttons). Enumerate them semantically and click each.
async function sweepObserve(stagehand: any, page: any): Promise<PullTier[] | null> {
  let opts: any[] = [];
  try {
    opts = await stagehand.observe(
      "each individual selectable pack-size / quantity / variant option for this product (the distinct size choices such as '16 oz', '1 Gallon', '25 kg', '5 lb') — NOT the add-to-cart button, NOT quantity steppers",
    );
  } catch {
    return null;
  }
  if (!Array.isArray(opts) || opts.length < 2) return null;

  const tiers: PullTier[] = [];
  const seen = new Set<string>();
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
      }
    } catch {
      /* one size failed — skip it, keep the rest of the ladder */
    }
  }
  return finalizeTiers(tiers);
}

async function sizeSweep(stagehand: any, page: any): Promise<PullTier[] | null> {
  const bySelect = await sweepSelect(stagehand, page).catch(() => null);
  if (bySelect && bySelect.length) return bySelect;
  return await sweepObserve(stagehand, page).catch(() => null);
}

// A Stagehand click failure is almost always a popup intercepting the target, so
// re-dismiss popups and retry with a short backoff.
async function actWithRetry(stagehand: any, page: any, action: any, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      const r = await stagehand.act(action);
      if (r?.success !== false) return r;
    } catch {
      /* fall through to the popup sweep and retry */
    }
    await dismissPopups(stagehand, page);
    await page.waitForTimeout(700 * (i + 1));
  }
  return null;
}

// Deterministic search-result click-through, for when the landing page is a
// results/category/root page with no price on it.
async function clickThroughToProduct(stagehand: any, page: any, material: string, variants: string[]): Promise<boolean> {
  const names = (variants.length ? variants : [material]).filter(Boolean);
  const before = page.url();
  let links: any[] = [];
  try {
    links = await stagehand.observe(
      `the product-result link that opens an individual product page for "${names[0]}"` +
        (names.length > 1 ? ` (also called ${names.slice(1).join(", ")})` : "") +
        `: the clickable product title/link in the search results or category listing. NOT ads, NOT the nav menu, NOT "add to cart", NOT pagination, NOT category headers.`,
    );
  } catch {
    links = [];
  }
  if (!Array.isArray(links) || !links.length) return false;
  await actWithRetry(stagehand, page, links[0]);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return page.url() !== before;
}

async function attempt(opts: {
  url: string;
  material: string;
  supplier: string;
  maxSteps: number;
  shipToAddress?: { country: string; state: string; city: string; zip: string } | null;
}): Promise<PullResult> {
  const { url, material, supplier, maxSteps, shipToAddress } = opts;
  const variants = materialVariants(material);
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    model: NAV_MODEL,
    verbose: 0,
    // An explicit logger is required, not cosmetic: left unset, Stagehand builds
    // a pino transport that resolves "pino-pretty" at runtime, which is not in
    // the serverless bundle, and every pull fails with "unable to determine
    // transport target for pino-pretty" before a browser is ever opened.
    logger: () => {},
    browserbaseSessionCreateParams: {
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      proxies: true,
      timeout: SESSION_TIMEOUT_SEC,
      browserSettings: { solveCaptchas: true, viewport: { width: 1288, height: 711 } },
    },
  } as any);
  await stagehand.init();
  const sessionId = (stagehand as any).sessionId;
  const viewUrl = `https://browserbase.com/sessions/${sessionId}`;
  try {
    const ctx: any = (stagehand as any).context;
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    let resp: any;
    try {
      resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e: any) {
      // Nav crashed/refused/timed out: transient proxy or DNS. Retry on a fresh IP.
      throw Object.assign(new Error(`navigation failed: ${String(e?.message ?? e).slice(0, 100)}`), { retry: true });
    }
    const status = resp?.status?.() ?? 0;
    if (status === 403 || status === 429 || status === 503) {
      throw Object.assign(new Error(`blocked (status ${status})`), { ban: true });
    }
    if (status === 404 || status === 410 || status === 451) {
      // An agent cannot recover a dead URL, so classify and stop without retrying.
      return {
        ...guard(emptyResult("link_broken", `HTTP ${status} — dead listing URL.`, url), url),
        viewUrl,
        sessionId,
      };
    }
    if (!resp || status === 0) throw Object.assign(new Error("navigation returned no response"), { retry: true });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    // A blank render is usually a transient proxy hiccup, not an empty listing.
    let initLen: number = await page.evaluate(() => (document.body as any)?.innerText?.trim().length ?? 0).catch(() => 0);
    if (initLen < 50) {
      await page.waitForTimeout(2500); // give a late-painting SPA a beat
      initLen = await page.evaluate(() => (document.body as any)?.innerText?.trim().length ?? 0).catch(() => 0);
      if (initLen < 50) throw Object.assign(new Error("blank page after load"), { retry: true });
    }

    await dismissPopups(stagehand, page);

    const readPrice = async () => {
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 3; i++) {
        const len = await page.evaluate(() => (document.body as any)?.innerText?.trim().length ?? 0).catch(() => 0);
        if (len > 200) break;
        await page.waitForTimeout(2000);
      }
      return extractPricing(page, supplier, material, page.url());
    };
    const hasPrice = (p: PullResult | null) => p?.classification === "current_price_found" && p?.current_price != null;

    // 1) A direct product URL often already shows the price.
    let price = await readPrice();

    // 2) Otherwise let the agent drive (search + navigate) for odd layouts.
    if (!hasPrice(price)) {
      const agent = (stagehand as any).agent();
      await agent
        .execute({ instruction: navInstruction(material, supplier, variants), maxSteps })
        .catch(() => null);
      price = await readPrice();
    }

    // 3) Still nothing: deterministic search-result click-through, then re-read.
    if (!hasPrice(price)) {
      const moved = await clickThroughToProduct(stagehand, page, material, variants).catch(() => false);
      if (moved) price = await readPrice();
    }

    // A multi-size selector is driven by us rather than the model, which rounds
    // and paraphrases numbers. This turns "$5.99 - $23.99" into a real ladder.
    const swept = await sizeSweep(stagehand, page).catch(() => null);
    if (swept && swept.length) {
      const first = swept[0];
      return {
        ...guard(
          {
            classification: "current_price_found",
            current_price: first.price,
            currency: price.currency ?? "USD",
            pack_size: first.pack_size,
            unit_price: first.unit_price,
            tiers: swept,
            notes: `Per-size ladder resolved by selecting each option (${swept.length} size(s)).`,
            source_url: page.url(),
          },
          page.url(),
        ),
        viewUrl,
        sessionId,
      };
    }

    const result = { ...guard(price, page.url()), viewUrl, sessionId };

    // Attempt to capture shipping cost if enabled and price was found
    if (
      shipToAddress &&
      result.classification === "current_price_found" &&
      result.current_price != null
    ) {
      try {
        const shippingResult = await captureShippingCost(page, stagehand, shipToAddress, supplier);
        if (shippingResult.shippingCost != null) {
          result.shippingCost = shippingResult.shippingCost;
          result.shippingAddress = shippingResult.shippingAddress;
        }
      } catch (e) {
        console.error("Shipping capture failed (non-fatal):", e);
        // Silently skip shipping failure — price capture succeeded, that's what matters
      }
    }

    return result;
  } finally {
    await stagehand.close().catch(() => {});
  }
}

// Under concurrency the workers must NOT retry a 429 in lockstep, which just
// re-hits the limit; the shared classifier's backoff is jittered for that.
async function backoff(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Agentic pull with retry. A 403/429/503, a model-router rate limit, a blank or
 * failed navigation, or a dead session each earn a fresh Stagehand session (and
 * so a fresh residential IP), up to maxAttempts.
 *
 * Optional shipToAddress enables shipping cost extraction from checkout after price capture.
 */
export async function agenticPull(opts: {
  url: string;
  material: string;
  supplier: string;
  maxSteps?: number;
  maxAttempts?: number;
  shipToAddress?: { country: string; state: string; city: string; zip: string } | null;
}): Promise<PullResult> {
  const { url, material, supplier, maxSteps = 15, maxAttempts = 4, shipToAddress } = opts;
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt({ url, material, supplier, maxSteps, shipToAddress });
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      // PERS-01: one classifier for the whole fleet. This loop used to keep its
      // own, narrower idea of retryable, so anything it did not recognise was
      // given up on after a single attempt. `scope: "page"` is what makes a 403
      // a bot wall to route around rather than a verdict about credentials.
      const v = classifyFailure(e, { attempt: i, scope: "page" });
      // Stagehand sets this itself when it wants the step replayed; there is no
      // status or message behind it for the classifier to read.
      if (v.verdict !== "retry" && e?.retry !== true) {
        return emptyResult("needs_review", `agentic pull error (${v.reason}): ${msg.slice(0, 160)}`, url);
      }
      if (v.rateLimited && i < maxAttempts - 1) await backoff(v.backoffMs);
    }
  }
  // Exhausted retries. `login_required` is only ever the model's reading of an
  // actual sign-in wall on the page: it escalates to a human on the first hit,
  // and sending one to a page that is not gated wastes the trip. A block, a 429
  // and an unclassified failure are all "we could not read it", so they say so
  // and stay in the retry rotation.
  const msg = String(lastErr?.message ?? lastErr);
  const v = classifyFailure(lastErr, { attempt: maxAttempts - 1, scope: "page" });
  return emptyResult("needs_review", `${v.reason} after ${maxAttempts} attempts: ${msg.slice(0, 120)}`, url);
}

// Shipping cost extraction from marketplace checkouts. After capturing product
// prices, attempt to fill in a test shipping address and extract the displayed
// shipping cost from the checkout summary. This captures the NUMERIC cost that
// appears only after address entry (not the static "Free shipping" text).
export interface ShippingCaptureResult {
  shippingCost: number | null; // numeric cost in USD, or null on failure
  currency: string | null; // currency code if non-USD
  shippingAddress: string | null; // formatted address used for the quote
  failedReason: string | null; // null on success, or explanation of failure
  attemptedAt: string;
}

async function fillShippingAddress(
  stagehand: Stagehand,
  page: any,
  address: { country: string; state: string; city: string; zip: string },
): Promise<boolean> {
  try {
    // Try to find and fill shipping address form fields semantically
    const fillAction = `Find the shipping address form fields (Country, State/Province, City, ZIP/Postal code) and fill them with:
Country: ${address.country}
State: ${address.state}
City: ${address.city}
ZIP: ${address.zip}

If the form uses dropdowns, select the matching option. If you can't find all fields, fill what you can find. Do NOT submit the form, just fill the fields and wait for the shipping cost to recalculate.`;

    await stagehand.act(fillAction);

    // Wait a moment for the page to recalculate shipping
    await page.waitForTimeout(2000);
    return true;
  } catch (error) {
    console.error("Failed to fill shipping address:", error);
    return false;
  }
}

async function extractShippingCost(stagehand: Stagehand, page: any, supplier: string): Promise<number | null> {
  try {
    // Extract the shipping cost displayed on the checkout page
    const result = await stagehand.extract(
      `Extract the NUMERIC shipping cost displayed on this checkout page. Look for labels like "Shipping", "Delivery", "Freight", "Shipping Cost", etc. Return the numeric value in USD (e.g., 25.00, 47.50, 0.00 for free shipping). If shipping is not visible or not a numeric value, return null.`,
      z.object({
        shippingCost: z.number().nullable(),
      }),
    );

    return result?.shippingCost ?? null;
  } catch (error) {
    console.error("Failed to extract shipping cost:", error);
    return null;
  }
}

export async function captureShippingCost(
  page: any,
  stagehand: Stagehand,
  address: { country: string; state: string; city: string; zip: string } | null,
  supplierName: string,
): Promise<ShippingCaptureResult> {
  const attemptedAt = new Date().toISOString();

  if (!address) {
    return {
      shippingCost: null,
      currency: null,
      shippingAddress: null,
      failedReason: "no_address_configured",
      attemptedAt,
    };
  }

  try {
    // Step 1: Attempt to navigate to cart/checkout if needed
    const currentUrl = page.url();
    const hasCheckout = /checkout|cart|shipping|order/.test(currentUrl.toLowerCase());

    if (!hasCheckout) {
      // Try to access the checkout page. This is best-effort; skip if it fails.
      try {
        // Most marketplaces have /checkout or /cart endpoints
        const baseUrl = new URL(currentUrl).origin;
        const checkoutUrls = [
          `${baseUrl}/checkout`,
          `${baseUrl}/cart`,
          `${baseUrl}/order`,
        ];

        let foundCheckout = false;
        for (const checkoutUrl of checkoutUrls) {
          try {
            await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
            foundCheckout = true;
            break;
          } catch {
            // Continue to next URL
          }
        }

        if (!foundCheckout) {
          // If checkout URLs fail, stay on product page and hope there's a quick-checkout widget
          // (like Shopify's buy button). This is acceptable failure — we tried.
        }
      } catch {
        // Silently skip checkout nav if it fails
      }
    }

    // Step 2: Fill shipping address fields
    const addressFilled = await fillShippingAddress(stagehand, page, address);
    if (!addressFilled) {
      return {
        shippingCost: null,
        currency: null,
        shippingAddress: `${address.city}, ${address.state}, ${address.zip}, ${address.country}`,
        failedReason: "address_form_not_found",
        attemptedAt,
      };
    }

    // Step 3: Extract the numeric shipping cost
    const shippingCost = await extractShippingCost(stagehand, page, supplierName);

    if (shippingCost !== null) {
      return {
        shippingCost,
        currency: "USD",
        shippingAddress: `${address.city}, ${address.state}, ${address.zip}, ${address.country}`,
        failedReason: null,
        attemptedAt,
      };
    } else {
      return {
        shippingCost: null,
        currency: null,
        shippingAddress: `${address.city}, ${address.state}, ${address.zip}, ${address.country}`,
        failedReason: "shipping_cost_not_extracted",
        attemptedAt,
      };
    }
  } catch (error) {
    console.error("Shipping capture error:", error);
    return {
      shippingCost: null,
      currency: null,
      shippingAddress: `${address.city}, ${address.state}, ${address.zip}, ${address.country}`,
      failedReason: `error: ${String(error).slice(0, 80)}`,
      attemptedAt,
    };
  }
}
