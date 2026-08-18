// Tier A½: deterministic Shopify price read, ported from the container-side
// `browserbase-price-pull` skill so it runs in the fleet instead of on a laptop.
//
// A Shopify store publishes its own canonical product JSON at
// `/products/<handle>.js` and its BASE currency at `/meta.json`. Reading those
// beats asking a model to read the rendered page: the DOM price can be stale,
// geo-localized, or `$0` until a variant script runs, which is exactly how the
// page-reading tiers mis-read per-size ladders. The feed gives every variant
// with an exact integer price in the minor unit of the shop's base currency.
//
// Measured on the container across the unpriced Shopify-host pool: 100 of 136
// leads priced (74%), 87 with a multi-size ladder, in 10 seconds. 110 of 455
// non-RFQ marketplace hosts are Shopify.
//
// Returns null whenever the host isn't Shopify or no confident product match
// exists, so the caller falls through to the normal model read. It never
// fabricates: no positive numeric price in the feed means null, never a guess.

import { correctMaterialSpelling } from "@/lib/material-spelling";
import type { RecheckResult } from "./price-recheck";

// Shopify serves a bot-flavoured UA nothing (or a 430/429). A normal browser UA
// gets the same JSON a shopper's browser would.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT_MS = 12_000;
const RATE_LIMIT_RETRIES = 2;

import { classifyFailure, classifyResponse } from "@/lib/retry-verdict";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, retries = RATE_LIMIT_RETRIES): Promise<any | null> {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        redirect: "follow",
        headers: { "user-agent": UA, accept: "application/json" },
      });
      // Shopify answers `local_rate_limited` with a 429 per shop per IP. It
      // clears in seconds, so back off rather than mis-recording the store as
      // unreadable and losing the whole host for this run.
      if (!res.ok) {
        // A 5xx or a rate limit is about this attempt, not about the store.
        // Returning null here used to write the whole host off for the run.
        const v = classifyResponse(res, null, { attempt, maxAttempts: retries + 1 });
        if (v.verdict === "retry") {
          await sleep(Math.min(v.backoffMs, 8000));
          continue;
        }
        return null;
      }
      // /products/<handle>.js is served as application/javascript, not JSON, so
      // parse the body ourselves and let an HTML error page fail out.
      const body = (await res.text()).trim();
      if (!body.startsWith("{")) return null;
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    } catch (e) {
      // A timeout or dropped connection is retryable; only give up once the
      // attempt budget is spent.
      if (classifyFailure(e, { attempt, maxAttempts: retries + 1 }).verdict === "retry") {
        clearTimeout(t);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}

// /meta.json carries the store's BASE currency, the one the .js feed quotes in.
// The geo/display currency a browser sees can differ, and trusting that is how a
// EUR store gets published as a USD number.
async function shopMeta(origin: string): Promise<{ currency: string } | null> {
  const j = await getJson(`${origin}/meta.json`);
  return j?.currency ? { currency: String(j.currency) } : null;
}

function handleFromUrl(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/products\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

// Material names are messy ("Cocamidopropyl Betaine (CAPB)"); require a real
// word overlap before trusting a search hit, so we never price a different
// product that merely happened to rank first.
function tokens(s: string | null | undefined): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[()[\],./-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

function titleMatchesMaterial(title: string, material: string): boolean {
  const want = tokens(material);
  if (!want.length) return false;
  const have = new Set(tokens(title));
  return want.some((w) => have.has(w));
}

async function suggest(origin: string, term: string): Promise<any[]> {
  const j = await getJson(
    `${origin}/search/suggest.json?q=${encodeURIComponent(term)}&resources[type]=product&resources[limit]=5`,
  );
  return j?.resources?.results?.products ?? [];
}

// A store's search is literal: "Cayanne Pepper" returns nothing where "Cayenne
// Pepper" returns the product, so try the corrected spelling first and fall back
// to the name as stored.
async function searchHandle(origin: string, material: string): Promise<string | null> {
  const corrected = correctMaterialSpelling(material);
  const terms = corrected && corrected !== material ? [corrected, material] : [material];
  for (const term of terms) {
    const hit = (await suggest(origin, term)).find((p: any) => titleMatchesMaterial(p?.title ?? "", term));
    if (hit?.handle) return hit.handle;
  }
  return null;
}

// Shopify quotes variant prices as an integer number of the currency's minor
// unit in the shop's base currency.
function variantPrice(v: any): number | null {
  const minor = typeof v?.price === "number" ? v.price : Number(v?.price);
  if (!Number.isFinite(minor)) return null;
  const price = minor / 100;
  // $0 is a feed placeholder for an unpriced variant, never a real price.
  return price > 0 ? price : null;
}

// Shopify names a single-variant product's only variant "Default Title". That is
// the absence of a pack size, not a pack size. Report null rather than
// substituting the product name, so QA can honestly flag "priced, size unknown".
function variantPackSize(v: any): string | null {
  const t = String(v?.title ?? "").trim();
  return t && t.toLowerCase() !== "default title" ? t : null;
}

/**
 * Attempt a deterministic price read. Resolves to null (cheaply, and for any
 * failure at all) when this isn't a Shopify product we can confidently match,
 * which the caller treats as "fall through to the model read".
 */
export async function shopifyFeedPull(opts: {
  url: string;
  material: string;
  supplier?: string | null;
}): Promise<RecheckResult | null> {
  const { url, material, supplier } = opts;

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }

  // Doubles as the Shopify probe: a non-Shopify host has no /meta.json.
  const meta = await shopMeta(origin);
  if (!meta) return null;

  let handle = handleFromUrl(url);
  let matchedVia: "url" | "search" = "url";
  if (!handle) {
    handle = await searchHandle(origin, material);
    matchedVia = "search";
  }
  if (!handle) return null;

  let product = await getJson(`${origin}/products/${encodeURIComponent(handle)}.js`);
  // A stale or renamed handle 404s, but the store may still carry the material.
  if (!product && matchedVia === "url") {
    const alt = await searchHandle(origin, material);
    if (alt && alt !== handle) {
      product = await getJson(`${origin}/products/${encodeURIComponent(alt)}.js`);
      handle = alt;
      matchedVia = "search";
    }
  }
  if (!product?.variants?.length) return null;

  // A URL-matched product is authoritative: the lead points straight at it. A
  // search-matched one has to actually look like the material we asked for.
  if (matchedVia === "search" && !titleMatchesMaterial(product.title ?? "", material)) return null;

  const tiers = product.variants
    .map((v: any) => ({ v, price: variantPrice(v) }))
    .filter((x: any) => x.price != null)
    .map((x: any) => ({
      pack_size: variantPackSize(x.v),
      price: x.price as number,
      unit_price: null,
    }));
  if (!tiers.length) return null;

  // The feed states availability explicitly, so pass it through rather than
  // leaving stock unknown. Only `false` is a claim; a missing field is not
  // evidence of being in stock.
  const soldOut = product.available === false;

  return {
    classification: "current_price_found",
    market_kind: "marketplace",
    aggregator: null,
    current_price: tiers[0].price,
    // The shop's base currency, read rather than inferred. The caller's
    // conversion step turns this into USD.
    currency: meta.currency,
    currency_authoritative: true,
    pack_size: tiers[0].pack_size,
    unit_price: null,
    tiers,
    moq: null,
    lead_time: null,
    shipping: null,
    stock_status: soldOut ? "out_of_stock" : null,
    stock_note: soldOut ? "Sold out (Shopify product feed)" : null,
    source_url: `${origin}/products/${handle}`,
    source_citations: [`${origin}/products/${handle}.js`, `${origin}/meta.json`],
    notes:
      `Shopify canonical feed (/products/${handle}.js), base currency ${meta.currency} from /meta.json, ` +
      `${tiers.length} priced variant(s), matched via ${matchedVia}.${supplier ? ` Supplier: ${supplier}.` : ""}`,
    index_page: false,
    sellers: [],
  };
}
