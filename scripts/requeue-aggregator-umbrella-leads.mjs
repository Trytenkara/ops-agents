// One-off backfill: requeue "umbrella" aggregator leads so Agent 05 splits them.
//
// An umbrella lead is one where the aggregator PLATFORM was recorded as the
// supplier ("Alibaba Marketplace (Multiple Sellers)", "TradeIndia (Platform)")
// or the URL is a category / search / showroom page. Neither is a supplier a
// buyer can contact, and the prices on such a page belong to a dozen different
// companies.
//
// Agent 05 now enumerates the individual sellers on those pages and replaces the
// umbrella row with one lead per real company. This script just makes the
// existing ones due for that pass: clear next_check_at (cohort B) or flip a
// terminal pull status back to pending (cohort A). It writes no leads itself.
//
// Usage: node scripts/requeue-aggregator-umbrella-leads.mjs [--apply]
//        (dry run by default)

import { readFileSync } from "node:fs";

const AGGREGATORS = [
  ["alibaba.com", "Alibaba"], ["aliexpress.com", "AliExpress"], ["1688.com", "1688"],
  ["made-in-china.com", "Made-in-China"], ["dhgate.com", "DHgate"], ["indiamart.com", "IndiaMART"],
  ["tradeindia.com", "TradeIndia"], ["exportersindia.com", "ExportersIndia"], ["ec21.com", "EC21"],
  ["tradekey.com", "TradeKey"], ["globalsources.com", "Global Sources"],
  ["go4worldbusiness.com", "Go4WorldBusiness"],
];
// Mirrors isAggregatorPlatformName / isAggregatorIndexUrl in src/lib/aggregator-hosts.ts.
const NAME_RES = AGGREGATORS.map(([, n]) => [new RegExp(`\\b${n.replace(/[^A-Za-z0-9]+/g, "[\\s\\-_.]*")}\\b`, "i"), n]);
const MULTI_SELLER = /\b(multiple|various|several|assorted|numerous|many)\s+(sellers?|suppliers?|vendors?|manufacturers?|listings?)\b|\blisted\s+(sellers?|suppliers?|vendors?)\b|\bseller\s+listings?\b/i;
const GENERIC = new Set(["marketplace", "marketplaces", "platform", "platforms", "portal", "site", "website", "listing", "listings", "listed", "supplier", "suppliers", "seller", "sellers", "vendor", "vendors", "manufacturer", "manufacturers", "exporter", "exporters", "multiple", "various", "several", "many", "assorted", "category", "categories", "search", "results", "result", "page", "pages", "directory", "aggregator", "wholesale", "b2b", "trade", "com", "the", "and", "on", "of", "via", "from", "group"]);
const INDEX_PATHS = [
  ["alibaba.com", /^\/(showroom|trade\/search|catalogs?|countrysearch|premium)/i],
  ["aliexpress.com", /^\/(wholesale|category|w\/)/i],
  ["1688.com", /^\/(s\/|page\/|offer_search)/i],
  ["made-in-china.com", /(productdirectory|products-search|\/catalog\/)/i],
  ["dhgate.com", /^\/wholesale\//i],
  ["indiamart.com", /^\/(impcat|search\.mp|cityoffer)/i],
  ["tradeindia.com", /^\/(manufacturers|search)/i],
  ["exportersindia.com", /^\/(indian-manufacturers|search)/i],
  ["ec21.com", /(product-search|\/offers\/)/i],
  ["tradekey.com", /^\/ks-/i],
  ["globalsources.com", /(searchList|product-search|\/manufacturers\/)/i],
  ["go4worldbusiness.com", /^\/(suppliers|search)/i],
];
const ROLLUP_PATH = /(-|\/)(suppliers|manufacturers|exporters|wholesalers)(-|\/|\.|$)/i;
const DETAIL_PATH = /\/(product-detail|proddetail|product|prod|item|offer)\//i;

const tokens = (s) => s.toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
function isPlatformName(name, material) {
  const raw = (name ?? "").trim();
  if (!raw) return false;
  if (MULTI_SELLER.test(raw)) return true;
  const hit = NAME_RES.find(([re]) => re.test(raw));
  if (!hit) return false;
  const generic = new Set(GENERIC);
  for (const t of tokens(material ?? "")) generic.add(t);
  return tokens(raw.replace(hit[0], " ")).every((t) => generic.has(t));
}
function isIndexUrl(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (!AGGREGATORS.some(([d]) => host === d || host.endsWith(`.${d}`))) return false;
  if (DETAIL_PATH.test(u.pathname)) return false;
  if (ROLLUP_PATH.test(u.pathname)) return true;
  return INDEX_PATHS.some(([d, re]) => (host === d || host.endsWith(`.${d}`)) && re.test(u.pathname));
}

const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
const fromEnvFile = (k) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : null;
};
const KEY = process.env.OA_SUPABASE_SERVICE_ROLE_KEY || fromEnvFile("OA_SUPABASE_SERVICE_ROLE_KEY");
const BASE = "https://aiyzpjnvenfmurhyamge.supabase.co/rest/v1";
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const apply = process.argv.includes("--apply");
const listingUrl = (p) => p?.enrichment?.contact?.contact_url ?? p?.supplier_website ?? p?.source_url ?? null;

const targets = [];
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(`${BASE}/leads_in_flight?select=id,supplier_name,material_name,payload&status=eq.active&limit=1000&offset=${offset}`, { headers });
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) break;
  for (const l of rows) {
    const url = listingUrl(l.payload);
    if (!url) continue;
    if (!isPlatformName(l.supplier_name, l.material_name) && !isIndexUrl(url)) continue;
    targets.push({ id: l.id, supplier_name: l.supplier_name, material_name: l.material_name, url, payload: l.payload });
  }
  if (rows.length < 1000) break;
}

console.log(`${targets.length} umbrella leads to requeue`);
for (const t of targets.slice(0, 20)) console.log(`  ${t.supplier_name} × ${t.material_name} → ${t.url}`);
if (targets.length > 20) console.log(`  ... and ${targets.length - 20} more`);
if (!apply) {
  console.log("dry run — pass --apply to write");
  process.exit(0);
}

let done = 0;
for (const t of targets) {
  const prior = t.payload?.marketplace_pull ?? null;
  // Cohort B (already pulled) is due when next_check_at is null; anything else
  // must look like a fresh/pending pull for cohort A to pick it up.
  const pull = prior?.status === "pulled"
    ? { ...prior, next_check_at: null }
    : prior
    ? { ...prior, status: "pending", attempts: 0, reason: "aggregator_index_requeue" }
    : null;
  const payload = { ...t.payload, site_type: "A" };
  if (pull) payload.marketplace_pull = pull;
  else delete payload.marketplace_pull;
  const res = await fetch(`${BASE}/leads_in_flight?id=eq.${t.id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) console.error(`failed ${t.id}: ${res.status} ${await res.text()}`);
  else if (++done % 25 === 0) console.log(`${done}/${targets.length}`);
}
console.log(`requeued ${done} leads`);
