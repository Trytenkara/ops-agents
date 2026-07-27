// Pure classifier for a lead's market kind from the scanner's site_type code.
// Lives in a plain (non-"use client") module so Server Components can call it —
// exporting it from a "use client" file turns it into an undefined client
// reference on the server ("is not a function"). Both server and client import
// it from here.
export function leadMarketKind(siteType: string | null | undefined): "marketplace" | "direct" | null {
  if (siteType === "M" || siteType === "MS") return "marketplace";
  if (siteType === "N") return "direct";
  return null;
}

// Column count for empty-state colSpan. Matches LeadRichHeaders. Pure helper,
// kept here so Server Components can call it (see note above).
export function leadRichColSpan(showOrg = true, selectable = false): number {
  return (showOrg ? 10 : 9) + (selectable ? 1 : 0);
}
