// Pure classifier for a lead's market kind from the scanner's site_type code.
// Lives in a plain (non-"use client") module so Server Components can call it —
// exporting it from a "use client" file turns it into an undefined client
// reference on the server ("is not a function"). Both server and client import
// it from here.
export type MarketKind = "marketplace" | "aggregator" | "direct";

export function leadMarketKind(siteType: string | null | undefined): MarketKind | null {
  if (siteType === "M" || siteType === "MS") return "marketplace";
  if (siteType === "A") return "aggregator";
  if (siteType === "N") return "direct";
  return null;
}

export const MARKET_KIND_LABEL: Record<MarketKind, string> = {
  marketplace: "Marketplace",
  aggregator: "Aggregator",
  direct: "Direct",
};

export const NON_MARKETPLACE_SUFFIX = "Non-marketplace";

export interface OriginMarketplace {
  platform?: string | null;
  site_type?: string | null;
  listing_url?: string | null;
  split_at?: string | null;
  trigger?: string | null;
}

// A direct lead that came OUT of a marketplace listing, either because the seller
// replied from its own address (splitDirectLeadFromMarketplace) or because the
// page turned out to have no checkout. Distinct from a lead that was discovered
// as direct in the first place — only the former shares a supplier name with a
// live listing row, which is what the display suffix disambiguates.
export function isReclassifiedDirect(payload: Record<string, any> | null | undefined): boolean {
  const p = payload ?? {};
  return Boolean(p.origin_marketplace_lead_id || p.reclassified_from === "marketplace");
}

export function originMarketplaceOf(
  payload: Record<string, any> | null | undefined,
): OriginMarketplace | null {
  if (!isReclassifiedDirect(payload)) return null;
  return ((payload ?? {}).origin_marketplace ?? {}) as OriginMarketplace;
}

// "<supplier> - Non-marketplace". The same company can hold both a listing row
// (which the price index publishes from) and a direct row (which owns the email
// thread and the quotes); without the suffix the two read as duplicates.
export function nonMarketplaceDisplayName(
  supplierName: string | null | undefined,
  payload: Record<string, any> | null | undefined,
): string {
  const base = supplierName?.trim() || "—";
  if (!isReclassifiedDirect(payload)) return base;
  if (base === "—") return NON_MARKETPLACE_SUFFIX;
  return `${base} - ${NON_MARKETPLACE_SUFFIX}`;
}

// Badge variant per kind, shared so every table reads the same: indigo =
// transactable marketplace, amber = aggregator (low-trust indicative ask),
// grey = direct supplier.
export const MARKET_KIND_VARIANT: Record<MarketKind, "accent" | "warn" | "secondary"> = {
  marketplace: "accent",
  aggregator: "warn",
  direct: "secondary",
};

export const MARKET_KIND_TITLE: Record<MarketKind, string> = {
  marketplace: "Marketplace — you can check out and buy online",
  aggregator: "Aggregator — multi-seller platform, orders go through a Send Inquiry form. Listed prices are indicative asks, not transactable.",
  direct: "Direct supplier — quote / RFQ only",
};

// Column count for empty-state colSpan. Matches LeadRichHeaders. Pure helper,
// kept here so Server Components can call it (see note above).
export function leadRichColSpan(showOrg = true, selectable = false): number {
  return (showOrg ? 11 : 10) + (selectable ? 1 : 0);
}
