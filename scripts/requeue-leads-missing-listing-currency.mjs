// One-off backfill: make every marketplace lead with no recorded listing
// currency due for re-check, so it picks up native price + rate.
//
// Until now the price pull converted a foreign listing to USD in place and threw
// the original away. Those leads therefore have a USD price with no listed-currency
// figure and no rate behind it, which means two things are impossible for them:
// the currency-vs-supplier delta split has nothing to split, and Agent 16's FX
// refresh has nothing to restate (it keys on native_currency).
//
// There is no way to recover the missing data by computation. Back-inferring a
// native price by dividing today's USD figure by today's rate would invent a
// number the page never showed, at a rate that is not the one the original
// conversion used. So the only honest fix is to read the page again, and all this
// script does is make that happen sooner: it clears next_check_at, which cohort B
// treats as due and orders first (nullsFirst). It writes no prices itself.
//
// USD-listed leads need no nudge — they self-heal on their normal cadence, and
// the delta split already treats a USD listing as fully supplier-attributable.
//
// Scope is EVERY pulled lead with no recorded listing currency, not just the
// foreign-host subset. Two reasons it is not narrower:
//
//   1. Correctness. A null listing currency now means "unknown", not "USD" (see
//      tierDelta). So every legacy lead, dollar-listed or not, renders its deltas
//      as n/a until it is read again. Re-reading only the ~20% foreign subset
//      would leave ~1,000 rows permanently blank in the Price Index.
//   2. We cannot tell which legacy leads are foreign without re-reading them. The
//      host list below is a decent guess, and a guess is fine for prioritisation
//      but not for deciding which rows stay blank forever.
//
// The cost is the AIMD volatility ladder: nulling next_check_at makes the whole
// pulled pool due at once, so the cadence restarts from its floor and re-check
// volume runs at the cap for about a day before widening again. That is a
// deliberate one-time spend, not a permanent rate change.
//
// Foreign-listed leads still go FIRST (they are the ones whose deltas are
// currently capable of being silently wrong rather than merely blank), and real
// clients outrank internal test orgs inside each group via Agent 05's own
// priority query.
//
// Safe to re-run. A lead already carrying native_currency is skipped, so once a
// lead has been re-read it is never nudged again.
//
// Usage: node scripts/requeue-foreign-currency-price-leads.mjs [--apply]
//        (dry run by default)

import { readFileSync } from "node:fs";

// Hosts observed listing in something other than USD. Getting one wrong is not a
// data risk: the only consequence is a lead re-checked earlier than its cadence
// wanted. Add hosts here as they turn up.
const FOREIGN_HOSTS = [
  ["indiamart.com", "INR"],
  ["tradeindia.com", "INR"],
  ["exportersindia.com", "INR"],
  ["1688.com", "CNY"],
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
const listingUrl = (p) =>
  p?.marketplace_pull?.source_url ?? p?.source_url ?? p?.supplier_website ?? null;

function foreignCurrencyOf(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const hit = FOREIGN_HOSTS.find(([d]) => host === d || host.endsWith(`.${d}`));
  return hit ? hit[1] : null;
}

const targets = [];
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(
    `${BASE}/leads_in_flight?select=id,supplier_name,material_name,payload&status=eq.active&limit=1000&offset=${offset}`,
    { headers },
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) break;
  for (const l of rows) {
    const pull = l.payload?.marketplace_pull;
    if (pull?.status !== "pulled") continue;
    if (pull.native_currency) continue; // already re-read since the fix
    if (pull.next_check_at === null) continue; // already at the front of the queue
    const url = listingUrl(l.payload);
    targets.push({
      id: l.id,
      supplier_name: l.supplier_name,
      material_name: l.material_name,
      url,
      currency: foreignCurrencyOf(url) ?? "unknown",
      payload: l.payload,
    });
  }
  if (rows.length < 1000) break;
}

// Known-foreign first: those are the rows whose deltas would otherwise be
// silently misattributed, versus merely blank.
targets.sort((a, b) => (a.currency === "unknown" ? 1 : 0) - (b.currency === "unknown" ? 1 : 0));
const byCurrency = {};
for (const t of targets) byCurrency[t.currency] = (byCurrency[t.currency] ?? 0) + 1;
console.log(`${targets.length} priced leads with no recorded listing currency`, byCurrency);
for (const t of targets.slice(0, 20)) console.log(`  [${t.currency}] ${t.supplier_name} × ${t.material_name} → ${t.url}`);
if (targets.length > 20) console.log(`  ... and ${targets.length - 20} more`);
if (!apply) {
  console.log("dry run — pass --apply to write");
  process.exit(0);
}

let done = 0;
for (const t of targets) {
  const payload = {
    ...t.payload,
    marketplace_pull: { ...t.payload.marketplace_pull, next_check_at: null },
  };
  const res = await fetch(`${BASE}/leads_in_flight?id=eq.${t.id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) console.error(`failed ${t.id}: ${res.status} ${await res.text()}`);
  else if (++done % 25 === 0) console.log(`${done}/${targets.length}`);
}
console.log(`requeued ${done} leads`);
