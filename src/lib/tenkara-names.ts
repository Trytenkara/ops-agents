import { tenkaraQuery } from "./tenkara-readonly";
import { createAdminClient } from "@/lib/supabase/admin";

// Resolve supplier and material UUIDs to display names by hitting Tenkara prod.
// Used by /work pages where rows reference IDs but humans need names. We cache
// per-request via the caller passing maps in; the pool itself is process-wide
// so repeated calls in a single Next.js render share connections.

export async function resolveSupplierNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (unique.length === 0) return out;
  const rows = await tenkaraQuery<{ id: string; name: string }>(
    `select id::text as id, name from suppliers where id = any($1::uuid[])`,
    [unique]
  );
  for (const r of rows) out.set(r.id, r.name);
  return out;
}

export async function resolveMaterialNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (unique.length === 0) return out;
  const rows = await tenkaraQuery<{ id: string; name: string | null }>(
    `select id::text as id,
            coalesce(nullif(btrim(name), ''), nullif(btrim(trade_name), '')) as name
       from materials where id = any($1::uuid[])`,
    [unique]
  );
  for (const r of rows) if (r.name && r.name.trim()) out.set(r.id, r.name.trim());
  return out;
}

// Resolve material grades (materials.grade is a JSON array of {grade_name}).
// Returns a comma-joined grade string per material id, for surfacing grade on
// rows that only carry a material_id (e.g. staged quotes).
export async function resolveMaterialGrades(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (unique.length === 0) return out;
  const rows = await tenkaraQuery<{ id: string; grade: string | null }>(
    `select id::text as id,
            (select string_agg(g->>'grade_name', ', ')
               from jsonb_array_elements(coalesce(grade, '[]'::jsonb)) g) as grade
       from materials where id = any($1::uuid[])`,
    [unique]
  );
  for (const r of rows) if (r.grade) out.set(r.id, r.grade);
  return out;
}

// Resolve supplier names, falling back to the name we stored on the lead when
// Tenkara doesn't have the supplier_id (e.g. scout discoveries, or suppliers
// deleted/RLS-hidden in Tenkara). draft_references only stores supplier_id, so
// without this fallback those rows render as raw UUIDs in the UI.
export async function resolveSupplierNamesWithFallback(ids: string[]): Promise<Map<string, string>> {
  const names = await resolveSupplierNames(ids).catch(() => new Map<string, string>());
  const missing = Array.from(new Set(ids.filter((x) => x && !names.has(x))));
  if (missing.length === 0) return names;
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("leads_in_flight")
      .select("supplier_id, supplier_name")
      .in("supplier_id", missing)
      .not("supplier_name", "is", null);
    for (const r of (data ?? []) as { supplier_id: string | null; supplier_name: string | null }[]) {
      if (r.supplier_id && r.supplier_name && !names.has(r.supplier_id)) names.set(r.supplier_id, r.supplier_name);
    }
  } catch {
    /* OA fallback is best-effort */
  }
  return names;
}

// Tenkara's material_quotes table has no quote-number field. Build a human
// label from price/UOM + date so an operator can tell quotes apart on sight.
export async function resolveQuoteRefs(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (unique.length === 0) return out;
  const rows = await tenkaraQuery<{ id: string; price: number | null; uom: string | null; quote_date: string | null }>(
    `select id::text as id, price, unit_of_measurement as uom, quote_date::text as quote_date
       from material_quotes where id = any($1::uuid[])`,
    [unique]
  );
  for (const r of rows) {
    const parts: string[] = [];
    if (r.price != null) parts.push(`$${Number(r.price).toFixed(2)}${r.uom ? `/${r.uom}` : ""}`);
    if (r.quote_date) parts.push(new Date(r.quote_date).toLocaleDateString());
    out.set(r.id, parts.length ? parts.join(" · ") : r.id);
  }
  return out;
}

// Whether each supplier is a marketplace supplier (vs a direct/RFQ supplier).
// Lets platform-DB leads show a Marketplace/Direct type even without the
// scanner's site_type. Maps supplier_id → is_marketplace.
export async function resolveSupplierMarketplace(ids: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (unique.length === 0) return out;
  const rows = await tenkaraQuery<{ id: string; is_marketplace: boolean | null }>(
    `select id::text as id, coalesce(is_marketplace, false) as is_marketplace
       from suppliers where id = any($1::uuid[])`,
    [unique]
  );
  for (const r of rows) out.set(r.id, r.is_marketplace === true);
  return out;
}

// Quote expiry dates (the reason a re-quote is drafted). Maps quote_id → the
// product_expiry date string, so the UI can show "Expires <date>".
export async function resolveQuoteExpiries(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(ids.filter((x): x is string => !!x)));
  if (unique.length === 0) return out;
  const rows = await tenkaraQuery<{ id: string; product_expiry: string | null }>(
    `select id::text as id, product_expiry::text as product_expiry
       from material_quotes where id = any($1::uuid[]) and product_expiry is not null`,
    [unique]
  );
  for (const r of rows) {
    if (r.product_expiry) out.set(r.id, new Date(r.product_expiry).toLocaleDateString());
  }
  return out;
}
