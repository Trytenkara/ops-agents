// Lead-source directories, RFQ relays, and company-profile/data sites. Per ops
// (Mildred/Sam): these platforms are for PULLING LEADS, never for pricing. No
// price and no checkout option means it is not a marketplace, so a listing here
// must never be published as a marketplace price and must never open an ops
// signup ("log in to see price" on one of these fronts an inquiry form, not a
// cart). Decided host-side rather than per page so it costs no fetch and cannot
// be re-litigated by a reader that mistakes a registration wall for a checkout.
//
// Transactional B2B marketplaces (alibaba, made-in-china, indiamart, dhgate,
// chemondis, ...) are deliberately NOT here: some listings there really do check
// out, so they stay subject to the per-page checkout test in price-recheck.
const NEVER_MARKETPLACE_HOSTS = [
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
  "globalsources.com",
  "ec21.com",
  "tradekey.com",
  "go4worldbusiness.com",
  "exportersindia.com",
  "tradeindia.com",
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
];

export function isNeverMarketplaceHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, "");
  return NEVER_MARKETPLACE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

export function neverMarketplaceHostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const h = host.replace(/^www\./, "").toLowerCase();
  return isNeverMarketplaceHost(h) ? h : null;
}
