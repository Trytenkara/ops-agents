// One-off backfill: reclassify existing leads that live on an aggregator host
// (Alibaba, IndiaMART, Made-in-China, ...) to site_type 'A'.
//
// Before aggregators had their own market kind, these leads entered as MS and
// Agent 05's checkout test then downgraded them to N and blanked their price, or
// they sat in the marketplace tab with an inquiry-form ask shown as a checkout
// price. Both are wrong now. Stamping site_type 'A' moves them into the
// Aggregator tab and puts the downgraded ones back into the price-pull queue.
//
// Usage: node scripts/backfill-aggregator-site-type.mjs [--apply]
//        (dry run by default)

import { readFileSync } from "node:fs";

const AGGREGATORS = [
  "alibaba.com", "aliexpress.com", "1688.com", "made-in-china.com", "dhgate.com",
  "indiamart.com", "tradeindia.com", "exportersindia.com", "ec21.com", "tradekey.com",
  "globalsources.com", "go4worldbusiness.com",
];

const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
const fromEnvFile = (k) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : null;
};
const KEY = process.env.OA_SUPABASE_SERVICE_ROLE_KEY || fromEnvFile("OA_SUPABASE_SERVICE_ROLE_KEY");
const BASE = "https://aiyzpjnvenfmurhyamge.supabase.co/rest/v1";
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const apply = process.argv.includes("--apply");

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};
const isAggregator = (h) => !!h && AGGREGATORS.some((d) => h === d || h.endsWith(`.${d}`));

const targets = [];
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(`${BASE}/leads_in_flight?select=id,payload&status=eq.active&limit=1000&offset=${offset}`, { headers });
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) break;
  for (const l of rows) {
    const p = l.payload ?? {};
    if (p.site_type === "A") continue;
    // A direct lead split out of an aggregator listing keeps the listing URL as
    // provenance, so it still looks like an aggregator host here. Stamping 'A'
    // on it would put the supplier we now email directly back on the marketplace
    // track and undo the split.
    if (p.origin_marketplace_lead_id) continue;
    const host = hostOf(p.marketplace_pull?.source_url ?? p.source_url ?? p.supplier_website);
    if (isAggregator(host)) targets.push({ id: l.id, payload: p, host });
  }
  if (rows.length < 1000) break;
}

console.log(`${targets.length} leads to reclassify as site_type 'A'`);
if (!apply) {
  console.log("dry run — pass --apply to write");
  process.exit(0);
}

let done = 0;
for (const t of targets) {
  const res = await fetch(`${BASE}/leads_in_flight?id=eq.${t.id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ payload: { ...t.payload, site_type: "A" } }),
  });
  if (!res.ok) console.error(`failed ${t.id}: ${res.status} ${await res.text()}`);
  else if (++done % 200 === 0) console.log(`${done}/${targets.length}`);
}
console.log(`reclassified ${done} leads`);
