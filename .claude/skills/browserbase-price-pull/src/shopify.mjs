// Tier A½: deterministic Shopify price read (Ben's method, from the
// marketplace-supplier-extractor).
//
// A Shopify store publishes its own canonical product JSON at
// `/products/<handle>.js` and its BASE currency at `/meta.json`. Reading those
// beats rendering the page: the DOM price can be stale, geo-localized, or `$0`
// until a variant script runs, which is exactly how the browser tiers mis-read
// per-size ladders. The feed gives every variant with an exact integer price in
// cents of the shop's base currency.
//
// 110 of our 455 non-RFQ marketplace hosts are Shopify, so this prices a real
// slice of the pool with a plain fetch (no browser, no LLM, no proxy).
//
// Returns null when the host isn't Shopify or no matching product is found, so
// the caller simply falls through to the browser tiers. Never fabricates: no
// positive numeric price in the feed => null, never a guess.

// Shopify serves a bot-flavoured UA nothing (or a 430/429). A normal browser UA
// gets the same JSON a shopper's browser would fetch.
import { readFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT_MS = 12000;
const RATE_LIMIT_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { retries = RATE_LIMIT_RETRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA, accept: "application/json" } });
      // Shopify answers `local_rate_limited` with a 429 per shop per IP. It clears
      // in seconds, so back off rather than mis-recording the store as unreadable.
      if (res.status === 429 && attempt < retries) {
        clearTimeout(t);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      // /products/<handle>.js is served as application/javascript, not JSON, so
      // parse the body and let a non-JSON response (an HTML error page) fail out.
      const body = (await res.text()).trim();
      if (!body.startsWith("{")) return null;
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}

// /meta.json is Shopify-specific and carries the store's BASE currency, the one
// the .js feed quotes in. The geo/display currency a browser sees can differ, and
// trusting it is how a EUR store gets published as USD.
export async function shopMeta(origin) {
  const j = await getJson(`${origin}/meta.json`);
  if (!j || !j.currency) return null;
  return { currency: j.currency, name: j.name ?? null };
}

function handleFromUrl(url) {
  const m = new URL(url).pathname.match(/\/products\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Material names are messy ("Cocamidopropyl Betaine (CAPB)"); require a real word
// overlap before trusting a search hit, so we never price the wrong product.
function tokens(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[()\[\],./-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}
function titleMatchesMaterial(title, material) {
  const want = tokens(material);
  if (!want.length) return false;
  const have = new Set(tokens(title));
  return want.some((w) => have.has(w));
}

// A store's search is literal: "Cayanne Pepper" returns nothing where "Cayenne
// Pepper" returns the product. Reuse ops-agents' single curated misspelling list
// (lib/material-spelling.ts) rather than starting a second one that can drift; if
// the checkout isn't present we simply search the name as given.
let _misspellings;
function misspellings() {
  if (_misspellings) return _misspellings;
  _misspellings = new Map();
  try {
    const dir = process.env.OPS_AGENTS_DIR || "/workspace/ops-agents";
    const src = readFileSync(`${dir}/src/lib/material-spelling.ts`, "utf8");
    const block = src.match(/MATERIAL_MISSPELLINGS[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    for (const [, k, v] of block.matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) _misspellings.set(k.toLowerCase(), v);
  } catch {
    /* list unavailable, search the name as given */
  }
  return _misspellings;
}

function correctMaterial(material) {
  const map = misspellings();
  if (!map.size || !material) return material;
  return material.replace(/\b(\w+)\b/g, (w) => map.get(w.toLowerCase()) ?? w);
}

async function suggest(origin, term) {
  const j = await getJson(`${origin}/search/suggest.json?q=${encodeURIComponent(term)}&resources[type]=product&resources[limit]=5`);
  return j?.resources?.results?.products ?? [];
}

async function searchHandle(origin, material) {
  const corrected = correctMaterial(material);
  const terms = corrected !== material ? [corrected, material] : [material];
  for (const term of terms) {
    const products = await suggest(origin, term);
    const hit = products.find((p) => titleMatchesMaterial(p.title, term));
    if (hit) return hit.handle;
  }
  return null;
}

// Shopify quotes variant prices as an integer number of cents (or the currency's
// minor unit) in the shop's base currency.
function variantPrice(v) {
  const cents = typeof v?.price === "number" ? v.price : Number(v?.price);
  if (!Number.isFinite(cents)) return null;
  const price = cents / 100;
  return price > 0 ? price : null; // $0 = a feed placeholder / unpriced variant, never a real price
}

// Shopify names a single-variant product's only variant "Default Title". That is
// the absence of a pack size, not a pack size. Report null rather than substituting
// the product name, so downstream QA can honestly flag "priced, size unknown".
function variantPackSize(v) {
  const t = (v?.title || "").trim();
  return t && t.toLowerCase() !== "default title" ? t : null;
}

export async function shopifyPull({ url, material, supplier }) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }

  const meta = await shopMeta(origin);
  if (!meta) return null;

  let handle = handleFromUrl(url);
  let matchedVia = "url";
  if (!handle) {
    handle = await searchHandle(origin, material);
    matchedVia = "search";
  }
  if (!handle) return null;

  let product = await getJson(`${origin}/products/${encodeURIComponent(handle)}.js`);
  // A stale/renamed handle 404s; the store may still carry the material.
  if (!product && matchedVia === "url") {
    const alt = await searchHandle(origin, material);
    if (alt && alt !== handle) {
      product = await getJson(`${origin}/products/${encodeURIComponent(alt)}.js`);
      handle = alt;
      matchedVia = "search";
    }
  }
  if (!product?.variants?.length) return null;

  // A URL-matched product is authoritative (the lead points at it). A
  // search-matched one must actually look like the material we asked for.
  if (matchedVia === "search" && !titleMatchesMaterial(product.title, material)) return null;

  const tiers = [];
  for (const v of product.variants) {
    const price = variantPrice(v);
    if (price == null) continue;
    tiers.push({ pack_size: variantPackSize(v), price, unit_price: null });
  }
  if (!tiers.length) return null;

  const productUrl = `${origin}/products/${handle}`;
  return {
    classification: "current_price_found",
    current_price: tiers[0].price,
    currency: meta.currency,
    pack_size: tiers[0].pack_size,
    unit_price: null,
    tiers,
    source_url: productUrl,
    notes: `Shopify canonical feed (/products/${handle}.js), base currency ${meta.currency} from /meta.json, ${tiers.length} priced variant(s), matched via ${matchedVia}.${supplier ? ` Supplier: ${supplier}.` : ""}`,
  };
}
