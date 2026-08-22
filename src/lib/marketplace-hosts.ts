// Hosts where checkout does not exist, so a listing must never be published as a
// marketplace price and must never open an ops signup ("log in to see price"
// here fronts an inquiry form, not a cart). Decided host-side rather than per
// page so it costs no fetch and cannot be re-litigated by a reader that mistakes
// a registration wall for a checkout.
//
// Per ops the three market kinds are decided by two questions, in order:
//   1. Can you check out?              yes → marketplace (price is real)
//   2. Many suppliers, no checkout?     yes → aggregator (indicative ask, kept)
//   3. One company, no checkout?        yes → direct supplier (no price at all)
// Everything in this file is a "no" on 1, and the two lists below are the split
// between 3 and the leads-only case. Aggregators (question 2) live in
// lib/aggregator-hosts.ts because their printed numbers ARE kept.
//
// Transactional B2B marketplaces (chemondis, ingredientsonline, ...) are
// deliberately absent: some listings there really do check out, so they stay
// subject to the per-page checkout test in price-recheck.

// Lead-source directories, RFQ relays, and company-profile/data sites. The
// platform is never the supplier: these exist to FIND companies, and a row whose
// supplier is the platform itself has to be fanned out or dropped, not quoted.
export const DIRECTORY_HOSTS = [
  // Chemical/ingredient lead-gen directories — every "price" routes to an inquiry.
  "knowde.com",
  "ulprospector.com",
  "prospector.ul.com",
  "chemicalbook.com",
  "guidechem.com",
  "spotchemi.com",
  // General B2B directories.
  "thomasnet.com",
  "kompass.com",
  "europages.com",
  "taiwantrade.com",
  "environmental-expert.com",
  // Company-profile / data / customs-data providers.
  "bloomberg.com",
  "dnb.com",
  "crunchbase.com",
  "pitchbook.com",
  "zoominfo.com",
  "apollo.io",
  "lusha.com",
  "rocketreach.co",
  "opencorporates.com",
  "owler.com",
  "linkedin.com",
  "volza.com",
  "bebee.com",
  // Market-intelligence and supplier-discovery platforms: numbers on the page are
  // published market data or an inquiry, never a seller's transactable price.
  "tridge.com",
  "specialchem.com",
  "accio.com",
];

// One company's own catalogue with no checkout: a manufacturer or distributor
// selling its own book of products through a quote desk. The supplier is real
// and outreach treats it like any other direct supplier, there is simply no
// price to publish. Azelis is the shape: the product page prints no price, its
// "View pricing and place order" control is disabled until a human at the
// distributor approves a portal account, and the live CTAs are "Request a quote"
// and "Request a sample".
//
// The rest were sorted out of the parked backlog on 2026-08-04 and each one was
// then challenged by a second pass that went looking for a cart (/cart,
// /checkout, shop-platform fingerprints) and failed to find one. That pass
// overturned half the first-round calls, so only survivors are listed here; a
// host whose store is merely switched off stays out, because it can come back.
const DIRECT_NO_CHECKOUT_HOSTS = [
  "azelis.com",
  "dkshdiscover.com", // DKSH: the "cart" is a quote basket, "we will contact you"
  "itwreagents.com", // "Recommended prices only. For prices and orders contact your local distributor."
  "chemicalsunited.com",
  "powerockpharma.com",
  "nutriavenue.com",
  "hqorganics.com", // "Add to quote", every variant prints $0.00
  "davisco.co.in",
  "partner.birkengold.com", // partner portal only; the consumer shop is a different host
];

export type NoCheckoutKind = "directory" | "direct";

function matches(list: string[], h: string): boolean {
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

function bareHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isNeverMarketplaceHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  return matches(DIRECTORY_HOSTS, h) || matches(DIRECT_NO_CHECKOUT_HOSTS, h);
}

// Both kinds terminate the price pull; they differ in what the lead IS, so the
// caller can say so instead of calling a distributor a directory.
export function neverMarketplaceHostOf(
  url: string | null | undefined
): { host: string; kind: NoCheckoutKind } | null {
  const h = bareHost(url);
  if (!h) return null;
  if (matches(DIRECTORY_HOSTS, h)) return { host: h, kind: "directory" };
  if (matches(DIRECT_NO_CHECKOUT_HOSTS, h)) return { host: h, kind: "direct" };
  return null;
}
