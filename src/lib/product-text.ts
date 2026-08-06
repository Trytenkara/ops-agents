// The supplier evidence blob every capability judgement reads. Lives in lib/
// rather than inside the enrichment agent because the requirements re-check
// (lib/requirements-recheck.ts) has to rebuild the SAME evidence from a stored
// payload, months after enrichment ran, without importing the enrichment stack.
//
// Pure over the payload: given an unchanged lead, this returns an unchanged blob,
// which is what lets a verdict be recomputed instead of re-enriched.

// Collect the free-text product/description fields the discovery sources populate
// into one blob for overlap checking. Guards each field; several may be arrays
// (e.g. top_products).
export function collectProductText(payload: Record<string, any> | null | undefined): string {
  if (!payload) return "";
  const values = [
    payload.top_products,
    payload.product_description,
    payload.supplier_background,
    payload.trade_name,
    payload.grades_offered,
    payload.scout_notes,
    payload.importyeti?.top_products,
    payload.importyeti?.product_descriptions,
    payload.sourceready_tags,
    payload.sourceready?.tags,
    payload.sourceready?.products,
  ];
  const parts: string[] = [];
  const append = (value: any) => {
    if (value == null) return;
    if (Array.isArray(value)) value.forEach(append);
    else if (typeof value === "object") Object.values(value).forEach(append);
    else parts.push(String(value));
  };
  values.forEach(append);
  return parts.join(" ").trim();
}
