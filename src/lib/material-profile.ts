import { createAdminClient } from "@/lib/supabase/admin";
import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Material Profile data layer + pure compute fns.
//
// Materials come from Tenkara (read-only). Order history comes from
// client_material_orders in OA (ops upload + LLM parse). We merge the two,
// compute usage frequency, and recommend a minimum acceptable shelf-life
// (material + COA) per material.

// --- shelf-life recommendation knobs (tune here) ---
// A single order = N months of supply, so the lot must outlive N months with
// headroom. Floor at 6mo (no point demanding more for fast movers), cap at 60mo
// (5yr — beyond that the spec stops mattering).
export const SAFETY_FACTOR = 1.5;
export const MIN_SHELF_LIFE_MONTHS = 6;
export const MAX_SHELF_LIFE_MONTHS = 60;

export interface OrderLineRow {
  id: string;
  tenkara_material_id: string | null;
  material_label: string;
  supplier_name: string | null;
  order_date: string | null;
  ordered_qty: number | null;
  qty_unit: string | null;
  po_qty: number | null;
  unit_price: number | null;
  coa_expiry: string | null;
  material_expiry: string | null;
  status: string;
  created_at: string;
}

export interface FrequencyResult {
  orderCount: number;
  ordersPerYear: number | null;
  label: "Monthly+" | "Quarterly" | "Annual" | "Infrequent" | "No data";
}

export interface MaterialProfileRow {
  tenkaraMaterialId: string | null;
  label: string;
  annualVolume: number | null;
  volumeUnit: string | null;
  needType: string | null;
  acceptsBlanketOrders: boolean | null;
  currentQuoteExpiry: string | null;
  leadTimeDays: number | null;
  orders: OrderLineRow[];
  frequency: FrequencyResult;
  avgOrderQty: number | null;
  recommendedShelfLifeMonths: number | null;
  shortShelfLife: boolean;
}

export interface MaterialProfile {
  tenkaraConnected: boolean;
  materials: MaterialProfileRow[];
  unmatchedOrders: OrderLineRow[];
}

// --- pure compute fns (no I/O) ---

export function computeFrequency(orders: { order_date: string | null }[]): FrequencyResult {
  const dates = orders.map((o) => o.order_date).filter((d): d is string => !!d).map((d) => new Date(d).getTime()).filter((t) => !Number.isNaN(t));
  const orderCount = orders.length;
  if (dates.length < 1) return { orderCount, ordersPerYear: null, label: "No data" };
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  const msPerYear = 365.25 * 24 * 3600 * 1000;
  // Floor the span at one month so a couple of close-together orders don't
  // read as an absurdly high annual rate.
  const yearsSpan = Math.max((max - min) / msPerYear, 1 / 12);
  const ordersPerYear = dates.length / yearsSpan;
  let label: FrequencyResult["label"];
  if (ordersPerYear >= 10) label = "Monthly+";
  else if (ordersPerYear >= 3) label = "Quarterly";
  else if (ordersPerYear >= 1) label = "Annual";
  else label = "Infrequent";
  return { orderCount, ordersPerYear, label };
}

export function avgOrderQty(orders: { ordered_qty: number | null; order_date: string | null }[]): number | null {
  const qtys = orders.map((o) => o.ordered_qty).filter((q): q is number => typeof q === "number" && q > 0);
  if (qtys.length === 0) {
    // fallback: latest order by date with a positive qty
    const withDate = orders
      .filter((o) => typeof o.ordered_qty === "number" && o.ordered_qty! > 0)
      .sort((a, b) => new Date(b.order_date ?? 0).getTime() - new Date(a.order_date ?? 0).getTime());
    return withDate[0]?.ordered_qty ?? null;
  }
  return qtys.reduce((a, b) => a + b, 0) / qtys.length;
}

export function recommendMinShelfLifeMonths(
  annualVolume: number | null,
  orders: { ordered_qty: number | null; order_date: string | null }[]
): number | null {
  if (!annualVolume || annualVolume <= 0) return null;
  const avg = avgOrderQty(orders);
  if (avg == null || avg <= 0) return null;
  const monthlyUse = annualVolume / 12;
  const monthsOfSupply = avg / monthlyUse;
  const rec = Math.round(monthsOfSupply * SAFETY_FACTOR);
  return Math.min(Math.max(rec, MIN_SHELF_LIFE_MONTHS), MAX_SHELF_LIFE_MONTHS);
}

// True when the current quote's product expiry gives fewer months (from today)
// than we recommend — i.e. ops should request a longer shelf-life.
export function flagShortShelfLife(quoteExpiry: string | null, recommendedMonths: number | null): boolean {
  if (!quoteExpiry || recommendedMonths == null) return false;
  const expiry = new Date(quoteExpiry).getTime();
  if (Number.isNaN(expiry)) return false;
  const monthsToExpiry = (expiry - Date.now()) / (30.44 * 24 * 3600 * 1000);
  return monthsToExpiry < recommendedMonths;
}

// --- data layer ---

export async function getMaterialProfile(orgId: string): Promise<MaterialProfile> {
  const admin = createAdminClient();

  const { data: org } = await admin.from("orgs").select("tenkara_org_id").eq("id", orgId).maybeSingle();

  const { data: orderRows } = await admin
    .from("client_material_orders")
    .select("id, tenkara_material_id, material_label, supplier_name, order_date, ordered_qty, qty_unit, po_qty, unit_price, coa_expiry, material_expiry, status, created_at")
    .eq("org_id", orgId)
    .order("order_date", { ascending: false });
  const orders: OrderLineRow[] = (orderRows ?? []) as OrderLineRow[];

  if (!org?.tenkara_org_id) {
    return { tenkaraConnected: false, materials: [], unmatchedOrders: orders };
  }

  let tenkaraMaterials: any[] = [];
  try {
    tenkaraMaterials = await tenkaraQuery<any>(
      `select m.id::text as id,
              coalesce(m.trade_name, m.name) as label,
              m.annual_volume_expected, m.volume_unit, m.need_type, m.accepts_blanket_orders,
              q.product_expiry::text as current_quote_expiry, q.lead_time_days
         from public.materials m
         join public.users u on u.id = m.user_id
         left join public.material_quotes q on q.id = m.current_quote_id
        where u.organization_id = $1::uuid
          and coalesce(m.trade_name, m.name) is not null
        order by m.created_at desc limit 200`,
      [org.tenkara_org_id]
    );
  } catch {
    // Tenkara outage — still surface uploaded orders so ops aren't blocked.
    return { tenkaraConnected: false, materials: [], unmatchedOrders: orders };
  }

  const ordersByMaterial = new Map<string, OrderLineRow[]>();
  const matchedIds = new Set<string>();
  for (const o of orders) {
    if (o.tenkara_material_id) {
      matchedIds.add(o.tenkara_material_id);
      const list = ordersByMaterial.get(o.tenkara_material_id) ?? [];
      list.push(o);
      ordersByMaterial.set(o.tenkara_material_id, list);
    }
  }

  const materials: MaterialProfileRow[] = tenkaraMaterials.map((m) => {
    const matOrders = ordersByMaterial.get(m.id) ?? [];
    const annualVolume = m.annual_volume_expected != null ? Number(m.annual_volume_expected) : null;
    const rec = recommendMinShelfLifeMonths(annualVolume, matOrders);
    return {
      tenkaraMaterialId: m.id,
      label: m.label,
      annualVolume,
      volumeUnit: m.volume_unit ?? null,
      needType: m.need_type ?? null,
      acceptsBlanketOrders: m.accepts_blanket_orders ?? null,
      currentQuoteExpiry: m.current_quote_expiry ?? null,
      leadTimeDays: m.lead_time_days ?? null,
      orders: matOrders,
      frequency: computeFrequency(matOrders),
      avgOrderQty: avgOrderQty(matOrders),
      recommendedShelfLifeMonths: rec,
      shortShelfLife: flagShortShelfLife(m.current_quote_expiry ?? null, rec),
    };
  });

  const unmatchedOrders = orders.filter((o) => !o.tenkara_material_id);

  return { tenkaraConnected: true, materials, unmatchedOrders };
}
