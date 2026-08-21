// Aggregators — multi-seller B2B platforms that relay every order through a
// "Send Inquiry" / "Contact Supplier" form instead of a checkout (Alibaba,
// IndiaMART, Made-in-China, ...). They sit between a true marketplace and a
// direct supplier: unlike a lead directory they DO print numbers, but those are
// indicative asks from third-party sellers, not a price you can transact at.
//
// So they get their own market kind rather than being forced into the
// marketplace/direct binary: the price is kept and shown (with the aggregator it
// came from named on the row) but filtered separately, so nobody reads an
// Alibaba ask as a checkout price.
//
// Distinct from marketplace-hosts.ts NEVER_MARKETPLACE_HOSTS: those are pure
// lead-gen directories and company-profile sites with no price to keep at all.
const AGGREGATORS: Array<[host: string, name: string]> = [
  ["alibaba.com", "Alibaba"],
  ["aliexpress.com", "AliExpress"],
  ["1688.com", "1688"],
  ["made-in-china.com", "Made-in-China"],
  ["dhgate.com", "DHgate"],
  ["indiamart.com", "IndiaMART"],
  ["tradeindia.com", "TradeIndia"],
  ["exportersindia.com", "ExportersIndia"],
  ["ec21.com", "EC21"],
  ["tradekey.com", "TradeKey"],
  ["globalsources.com", "Global Sources"],
  ["go4worldbusiness.com", "Go4WorldBusiness"],
  // Sorted out of the parked backlog on 2026-08-04: each lists named third-party
  // sellers and relays every order through an inquiry form, so the printed number
  // is one of those sellers' asks.
  ["echemi.com", "Echemi"],
  ["pharmaoffer.com", "Pharmaoffer"],
  ["pharmacompass.com", "PharmaCompass"],
  ["ingredientsnetwork.com", "Ingredients Network"],
  ["nxtingredients.com", "NXT Ingredients"],
  ["nutrada.com", "Nutrada"],
  ["gather.tracegains.com", "TraceGains Gather"],
  ["globaltradeplaza.com", "Global Trade Plaza"],
  ["usetorg.com", "Usetorg"],
  ["globy.com", "Globy"],
  ["recycleblu.com", "RecycleBlu"],
];

export const AGGREGATOR_HOSTS: string[] = AGGREGATORS.map(([h]) => h);

function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  return host.toLowerCase().replace(/^www\./, "").trim() || null;
}

// Display name of the aggregator a host belongs to ("IndiaMART"), else null.
export function aggregatorNameOfHost(host: string | null | undefined): string | null {
  const h = normalizeHost(host);
  if (!h) return null;
  const hit = AGGREGATORS.find(([d]) => h === d || h.endsWith(`.${d}`));
  return hit ? hit[1] : null;
}

export function isAggregatorHost(host: string | null | undefined): boolean {
  return aggregatorNameOfHost(host) != null;
}

// Display name of the aggregator a URL points at ("Alibaba"), else null.
export function aggregatorNameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return aggregatorNameOfHost(new URL(url).hostname);
  } catch {
    return aggregatorNameOfHost(url.replace(/^https?:\/\//, "").split("/")[0]);
  }
}

// ---------------------------------------------------------------------------
// Umbrella detection: the platform is never the supplier.
//
// An aggregator hosts many third-party sellers, so a lead must point at ONE of
// those sellers, never at the platform or at one of its category / search /
// showroom pages. "Alibaba Marketplace (Multiple Sellers)" linking to
// /showroom/china-propylene-glycol.html is not a supplier a buyer can contact,
// and the numbers on such a page belong to a dozen different companies.
// ---------------------------------------------------------------------------

// Matches the platform's own name in a supplier field, allowing any separators
// ("Made-in-China", "Made in China", "MadeinChina").
const AGGREGATOR_NAME_RES: Array<[re: RegExp, name: string]> = AGGREGATORS.map(([, name]) => [
  new RegExp(`\\b${name.replace(/[^A-Za-z0-9]+/g, "[\\s\\-_.]*")}\\b`, "i"),
  name,
]);

// Phrases that admit outright that the row is a bundle of sellers, not a company.
const MULTI_SELLER_PHRASE = /\b(multiple|various|several|assorted|numerous|many)\s+(sellers?|suppliers?|vendors?|manufacturers?|listings?)\b|\blisted\s+(sellers?|suppliers?|vendors?)\b|\bseller\s+listings?\b/i;

// Words that carry no company identity, so a name made only of these plus the
// platform's own brand is the platform itself.
const GENERIC_PLATFORM_WORDS = new Set([
  "marketplace", "marketplaces", "platform", "platforms", "portal", "site", "website",
  "listing", "listings", "listed", "supplier", "suppliers", "seller", "sellers",
  "vendor", "vendors", "manufacturer", "manufacturers", "exporter", "exporters",
  "multiple", "various", "several", "many", "assorted", "category", "categories",
  "search", "results", "result", "page", "pages", "directory", "aggregator",
  "wholesale", "b2b", "trade", "com", "the", "and", "on", "of", "via", "from", "group",
]);

function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // drop parenthesized qualifiers: "(Multiple Sellers)"
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// True when a supplier name is the aggregator platform rather than a company
// selling on it. materialName (optional) lets a category row like
// "ExportersIndia Titanium Dioxide suppliers" be recognized too.
export function isAggregatorPlatformName(
  supplierName: string | null | undefined,
  materialName?: string | null,
): boolean {
  const raw = (supplierName ?? "").trim();
  if (!raw) return false;
  if (MULTI_SELLER_PHRASE.test(raw)) return true;
  const hit = AGGREGATOR_NAME_RES.find(([re]) => re.test(raw));
  if (!hit) return false;
  const generic = new Set(GENERIC_PLATFORM_WORDS);
  for (const t of nameTokens(materialName ?? "")) generic.add(t);
  // Everything left after removing the platform's own name must be filler.
  return nameTokens(raw.replace(hit[0], " ")).every((t) => generic.has(t));
}

// Category / search / showroom paths, per host: URL shape alone is not a
// reliable signal across platforms (made-in-china.com/showroom/<vendor> is one
// vendor's page while alibaba.com/showroom/<material> is a search result), so
// each pattern is scoped to the platform it was verified on.
const AGGREGATOR_INDEX_PATHS: Array<[host: string, re: RegExp]> = [
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

// A seller's OWN storefront on the platform. This list is the inverse of the
// index-path list above and is the one worth maintaining: each platform has a
// single storefront convention that changes rarely, whereas its category/search
// URL shapes are many and keep being added. So rather than trying to enumerate
// every index shape (which silently missed pharmaoffer's singular
// "/api-excipient-supplier/" and every host added after the patterns were
// written), we recognize the narrow single-seller case and treat the rest of an
// aggregator as possibly-an-index, letting the page itself settle it.
const AGGREGATOR_SELLER_STOREFRONT: Array<[host: string, re: RegExp | null]> = [
  // Vendor subdomains: xyz.en.alibaba.com, xyz.trustpass.alibaba.com,
  // xyz.en.made-in-china.com. A bare/www/m/dir host is never one seller.
  ["alibaba.com", null],
  ["made-in-china.com", null],
  // made-in-china.com/showroom/<vendor> is ONE vendor's shop (unlike
  // alibaba.com/showroom/<material>, which is a search result).
  ["made-in-china.com", /^\/showroom\//i],
];

const NON_SELLER_SUBDOMAINS = new Set(["", "www", "m", "dir", "www2", "us", "sale", "offer"]);

// True when the URL is one seller's own storefront/product page on the platform,
// so there is no roster on it to fan out.
export function isAggregatorSellerStorefrontUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = normalizeHost(parsed.hostname);
  if (!host) return false;
  for (const [d, re] of AGGREGATOR_SELLER_STOREFRONT) {
    if (host !== d && !host.endsWith(`.${d}`)) continue;
    if (re) {
      if (re.test(parsed.pathname)) return true;
      continue;
    }
    // Vendor-subdomain form: strip the platform domain and any locale label
    // ("en", "trustpass") and require a remaining label that names the vendor.
    const labels = host.slice(0, Math.max(0, host.length - d.length - 1)).split(".");
    const vendor = labels.filter((l) => l !== "en" && l !== "trustpass").join(".");
    if (vendor && !NON_SELLER_SUBDOMAINS.has(vendor)) return true;
  }
  return false;
}

// Cross-platform: these hosts publish per-material roll-up pages as
// "<material>-suppliers.html" / "china-suppliers/<material>.htm". Singular is
// allowed because Pharmaoffer writes "/api-excipient-supplier/<category>/<material>";
// a seller's own storefront is excluded before this runs, so a vendor slug that
// happens to contain "-supplier" cannot be caught by it.
const AGGREGATOR_ROLLUP_PATH = /(-|\/)(suppliers?|manufacturers?|exporters?|wholesalers?|vendors?|distributors?)(-|\/|\.|$)/i;
// ...but one seller's own listing can carry the same words in its product slug
// ("/product-detail/hydroxyethyl-cellulose-hec-manufacturers-HECELLOSE_1600.html"),
// so an explicit detail path always wins over the roll-up guess.
const AGGREGATOR_DETAIL_PATH = /\/(product-detail|proddetail|product|prod|item|offer)\//i;

// True when the URL is an aggregator's multi-seller index page rather than one
// seller's listing.
export function isAggregatorIndexUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = normalizeHost(parsed.hostname);
  if (!host) return false;
  if (!isAggregatorHost(host)) return false;
  if (AGGREGATOR_DETAIL_PATH.test(parsed.pathname)) return false;
  if (isAggregatorSellerStorefrontUrl(url)) return false;
  if (AGGREGATOR_ROLLUP_PATH.test(parsed.pathname)) return true;
  return AGGREGATOR_INDEX_PATHS.some(
    ([d, re]) => (host === d || host.endsWith(`.${d}`)) && re.test(parsed.pathname),
  );
}

// Whether to ask the price reader for the page's seller roster. The URL patterns
// above only ever produce a HINT: they are hand-maintained, so they lag every new
// platform and every URL redesign. The page itself is the authority, and the
// reader is already told to fall back to a normal price read when the page turns
// out to be one seller's listing (INDEX_PAGE_RULES). So the question here is not
// "is this an index page" but the cheaper "could it be", and we answer yes for
// anything on an aggregator that is not provably one seller's own page.
//
// Erring toward yes costs output tokens on a page that reads normally anyway;
// erring toward no silently loses every seller on the page, which is what the
// allowlist was doing.
export function shouldEnumerateAggregatorSellers(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!isAggregatorHost(normalizeHost(parsed.hostname))) return false;
  if (AGGREGATOR_DETAIL_PATH.test(parsed.pathname)) return false;
  if (isAggregatorSellerStorefrontUrl(url)) return false;
  return true;
}

// Which aggregator a lead's price came from, for display on the row. Agent 05
// stamps the name on the pull; older rows and off-list platforms fall back to
// the listing host so the source is never left unnamed.
export function aggregatorNameFromPayload(payload: any): string | null {
  const stamped = payload?.marketplace_pull?.aggregator;
  if (typeof stamped === "string" && stamped.trim()) return stamped.trim();
  const url = payload?.marketplace_pull?.source_url ?? payload?.source_url ?? payload?.supplier_website;
  if (typeof url !== "string") return null;
  const named = aggregatorNameOf(url);
  if (named) return named;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// DISC-05. A platform's own inbox is not a supplier's contact. `info@pharmaoffer.com`
// stamped on Pharmaoffer is honest — the platform IS the company being written to.
// The same address stamped on "Shandong Longda Bio-Products" is not: it reaches
// the directory, which forwards or does not, and the reply arrives from the
// platform rather than the manufacturer. Both shapes are live today.
export function isPlatformOwnedContact(
  email: string | null | undefined,
  supplierName: string | null | undefined
): { blocked: boolean; platform: string | null } {
  const at = (email ?? "").split("@")[1]?.trim().toLowerCase();
  if (!at) return { blocked: false, platform: null };
  const platform = aggregatorNameOfHost(at);
  if (!platform) return { blocked: false, platform: null };
  // Writing to the platform about the platform is fine.
  const named = (supplierName ?? "").trim().toLowerCase();
  const self = named.length > 0 && (named.includes(platform.toLowerCase()) || platform.toLowerCase().includes(named));
  return { blocked: !self, platform };
}
