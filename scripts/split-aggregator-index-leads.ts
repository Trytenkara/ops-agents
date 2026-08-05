// One-off backfill: split the "umbrella" aggregator leads already on file.
//
// An umbrella lead is one where the aggregator PLATFORM was recorded as the
// supplier ("Alibaba Marketplace (Multiple Sellers)") or the URL is a category /
// search / showroom page. Neither is a company a buyer can contact, and the
// prices on such a page belong to a dozen different sellers.
//
// Agent 05 now handles these as it re-checks them, but only for orgs that are
// actively sourcing and only at its per-run cap, so the existing rows would keep
// showing a platform link for days. This runs the same reader and the same
// fan-out (imported, not reimplemented) across every org right now.
//
// Usage: node --experimental-strip-types --experimental-loader ./scripts/ts-alias-loader.mjs \
//          scripts/split-aggregator-index-leads.ts [--apply] [--limit N]
//        (dry run by default)
import { readFileSync } from "node:fs";
for (const line of readFileSync("/workspace/.env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://aiyzpjnvenfmurhyamge.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= process.env.OA_SUPABASE_SERVICE_ROLE_KEY;

const { createAdminClient } = await import("@/lib/supabase/admin");
const { isAggregatorIndexUrl, isAggregatorPlatformName } = await import("@/lib/aggregator-hosts");
const { recheckMarketplaceQuote } = await import("@/agents-runtime/agents/marketplace-validation/price-recheck");
const { expandAggregatorIndexPage } = await import("@/agents-runtime/agents/marketplace-validation/lead-price-pull");

const apply = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const admin = createAdminClient();
const listingUrl = (p: any): string | null =>
  p?.enrichment?.contact?.contact_url ?? p?.supplier_website ?? p?.source_url ?? null;

const rows: any[] = [];
for (let offset = 0; ; offset += 1000) {
  const { data, error } = await admin
    .from("leads_in_flight")
    .select("id, org_id, supplier_id, supplier_name, material_id, material_name, source, payload")
    .eq("status", "active")
    .order("id") // paging without a total order silently skips and repeats rows
    .range(offset, offset + 999);
  if (error) throw new Error(error.message);
  if (!data?.length) break;
  rows.push(...data);
  if (data.length < 1000) break;
}
// Only the platform-as-supplier shape is retired here. A real company whose URL
// happens to be a category page keeps its lead: Agent 05 repairs that link on
// its next pass.
const targets = rows.filter(
  (l) => isAggregatorPlatformName(l.supplier_name, l.material_name) && isAggregatorIndexUrl(listingUrl(l.payload)),
);
console.log(`${rows.length} active leads · ${targets.length} platform-as-supplier rows on an index URL`);
if (!apply) {
  for (const t of targets.slice(0, 30)) console.log(`  ${t.supplier_name} × ${t.material_name} → ${listingUrl(t.payload)}`);
  console.log("dry run — pass --apply to split");
  process.exit(0);
}

let split = 0;
let staged = 0;
let empty = 0;
for (const l of targets.slice(0, limit)) {
  const indexUrl = listingUrl(l.payload)!;
  const result = await recheckMarketplaceQuote({
    supplier_name: l.supplier_name ?? "",
    material_name: l.material_name ?? "",
    product_url: indexUrl,
    baseline_price: null,
    case_size: null,
    unit: null,
    enumerate_sellers: true,
    // This script only ever targets platform-as-supplier rows (see `targets`), so
    // the row is known to be an index page before the page is read.
    index_page_expected: true,
  });
  // A page whose sellers we cannot read is still retired, exactly as Agent 05
  // retires it: the platform was never a supplier, so leaving the row in place
  // just keeps a category link on the board. (Alibaba showrooms render their
  // roster client-side and often come back empty; those need the Browserbase
  // escalation, not a second read.)
  if (!result.sellers.length) {
    empty++;
    console.log(`  0 sellers readable, retiring: ${l.supplier_name} × ${l.material_name} (${result.classification})`);
  }
  const n = await expandAggregatorIndexPage({
    admin,
    log: (m: string) => console.log(`    ${m}`),
    runId: null,
    lead: l,
    indexUrl,
    sellers: result.sellers,
    retireParent: true,
  });
  split++;
  staged += n;
  if (n) console.log(`  ${l.supplier_name} × ${l.material_name} → ${n} seller lead(s)`);
}
console.log(`retired ${split} index pages, staged ${staged} seller leads · ${empty} had no readable seller`);
