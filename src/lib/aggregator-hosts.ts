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
