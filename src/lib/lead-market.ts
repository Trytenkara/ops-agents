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
