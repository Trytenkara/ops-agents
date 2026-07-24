import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Price Pulse — per-material price statistics over the live Tenkara
// material_quotes corpus. Read-only on Tenkara.
//
// Modeling decisions grounded in the real data:
//  - Raw per-case price is not comparable (case sizes differ wildly), so we
//    normalize to a per-unit price (price / case_size) and group by
//    (material_id, unit_of_measurement). material_id is effectively per-client
//    in Tenkara, so a material's "market" is the set of suppliers who quoted
//    that material.
//  - Only current quotes count: replaced_quote_id is null, price > 0,
//    case_size > 0.
//  - Sample quotes (sample_status = 'sample') are excluded — they carry tiny
//    sizes / token prices that distort the spread.
//  - A median-based outlier guard drops unit prices below 10% or above 10x the
//    group median. These are almost always unit-mislabeled rows (e.g. a quote
//    priced per gram while tagged kg) and otherwise produce fake "savings".

export interface PricePulseStat {
  material_id: string;
  material_name: string;
  grade: string | null;
  unit: string;
  n_quotes: number;
  n_suppliers: number;
  min_unit_price: number;
  avg_unit_price: number;
  max_unit_price: number;
  cheapest_supplier_id: string | null;
  cheapest_supplier_name: string | null;
  // Marketplace/source link for the cheapest supplier's quote (may be null —
  // only ~half of quotes carry a product_url).
  cheapest_product_url: string | null;
  // The client org that owns this material (materials.user_id → users →
  // organizations). material_id is effectively per-client in Tenkara.
  org_id: string | null;
  org_name: string | null;
}

const MIN_QUOTES_DEFAULT = 3;

// Shared CTE chain: normalize → median → outlier-filtered set. Callers append
// their own SELECT. `$1` is always the org filter sentinel handling below.
function pulseCte(orgFilter: string): string {
  return `
    with norm as (
      select mq.material_id,
             mq.supplier_id,
             mq.product_url,
             lower(coalesce(nullif(trim(mq.unit_of_measurement), ''), '?')) as unit,
             (mq.price / nullif(mq.case_size, 0))::double precision as unit_price
        from public.material_quotes mq
        join public.materials m on m.id = mq.material_id
        left join public.users u on u.id = m.user_id
       where mq.replaced_quote_id is null
         and mq.price is not null and mq.price > 0
         and mq.case_size is not null and mq.case_size > 0
         and coalesce(mq.sample_status::text, '') <> 'sample'
         ${orgFilter}
    ),
    med as (
      select material_id, unit,
             percentile_cont(0.5) within group (order by unit_price) as median_unit_price
        from norm
       group by material_id, unit
    ),
    filt as (
      select n.*
        from norm n
        join med d on d.material_id = n.material_id and d.unit = n.unit
       where d.median_unit_price is null
          or n.unit_price between d.median_unit_price * 0.1 and d.median_unit_price * 10
    )`;
}

// Pulse across all materials (optionally restricted to a Tenkara org and a
// minimum quote count so thin materials don't produce noisy stats).
export async function getPricePulse(opts?: {
  tenkaraOrgId?: string | null;
  minQuotes?: number;
  limit?: number;
}): Promise<PricePulseStat[]> {
  const minQuotes = opts?.minQuotes ?? MIN_QUOTES_DEFAULT;
  const limit = opts?.limit ?? 500;
  const params: any[] = [minQuotes];
  let orgFilter = "";
  if (opts?.tenkaraOrgId) {
    params.push(opts.tenkaraOrgId);
    orgFilter = `and u.organization_id = $${params.length}::uuid`;
  }
  params.push(limit);
  const limitIdx = params.length;

  return tenkaraQuery<PricePulseStat>(
    `
    ${pulseCte(orgFilter)},
    agg as (
      select f.material_id, f.unit,
             count(*)::int as n_quotes,
             count(distinct f.supplier_id)::int as n_suppliers,
             min(f.unit_price) as min_unit_price,
             avg(f.unit_price) as avg_unit_price,
             max(f.unit_price) as max_unit_price
        from filt f
       group by f.material_id, f.unit
      having count(*) >= $1
    ),
    cheapest as (
      select distinct on (f.material_id, f.unit)
             f.material_id, f.unit, f.supplier_id as cheapest_supplier_id,
             f.product_url as cheapest_product_url
        from filt f
       order by f.material_id, f.unit, f.unit_price asc
    )
    select a.material_id,
           m.name as material_name,
           (select string_agg(g->>'grade_name', ', ')
              from jsonb_array_elements(coalesce(m.grade, '[]'::jsonb)) g) as grade,
           a.unit,
           a.n_quotes,
           a.n_suppliers,
           round(a.min_unit_price::numeric, 6)::double precision as min_unit_price,
           round(a.avg_unit_price::numeric, 6)::double precision as avg_unit_price,
           round(a.max_unit_price::numeric, 6)::double precision as max_unit_price,
           c.cheapest_supplier_id,
           s.name as cheapest_supplier_name,
           c.cheapest_product_url,
           o.id as org_id,
           o.name as org_name
      from agg a
      join public.materials m on m.id = a.material_id
      left join public.users mu on mu.id = m.user_id
      left join public.organizations o on o.id = mu.organization_id
      left join cheapest c on c.material_id = a.material_id and c.unit = a.unit
      left join public.suppliers s on s.id = c.cheapest_supplier_id
     order by o.name nulls last, m.name, a.unit, a.n_quotes desc
     limit $${limitIdx}
    `,
    params
  );
}

export interface ClientBenchmark extends PricePulseStat {
  // The client's "currently supply $" = their material's current_quote. When the
  // client hasn't entered a current price, this falls back to the market average
  // (see has_client_price) so the material still benchmarks instead of dropping.
  client_unit_price: number;
  // false when there's no client current-supply price and we benchmarked against
  // the market average instead.
  has_client_price: boolean;
  // Where the client cost came from: their Tenkara current_quote, or a unit price
  // parsed off an uploaded PO. null when there's no client price (market-avg).
  client_price_source: "tenkara" | "po" | null;
  // Where the client's price sits in the spread (0 = at min, 1 = at max).
  percentile: number;
  // Positive => client is paying above the market average.
  vs_avg_pct: number;
  position: "below_market" | "at_market" | "above_market";
}

// Benchmark a single client's accepted prices against the spread of supplier
// quotes for each of their materials. "Their price" is the cheapest APPROVED
// quote (the one they signed off on); we compare it to the min/avg/max of all
// (non-sample, outlier-guarded) quotes for the same material/unit.
export async function getClientBenchmark(
  tenkaraOrgId: string,
  // clientCostFallback: unit prices parsed from uploaded POs, keyed by
  // `${tenkara_material_id}|${unit}`. Used as the client's current cost only when
  // Tenkara has no current_quote for that material+unit, so the client baseline
  // is populated instead of silently falling back to the market average. (#5)
  opts?: { minQuotes?: number; clientCostFallback?: Map<string, number> }
): Promise<ClientBenchmark[]> {
  const pulse = await getPricePulse({ tenkaraOrgId, minQuotes: opts?.minQuotes });
  const pulseByKey = new Map<string, PricePulseStat>();
  for (const p of pulse) pulseByKey.set(`${p.material_id}|${p.unit}`, p);

  // The client's "currently supply $" — the price they entered when adding the
  // material, stored as the material's current_quote. This is the sourcing
  // benchmark baseline (NOT the cheapest approved quote, which could be a price
  // we sourced). One current_quote per material, so no aggregation.
  const approved = await tenkaraQuery<{
    material_id: string;
    unit: string;
    client_unit_price: number;
  }>(
    `
    select m.id::text as material_id,
           lower(coalesce(nullif(trim(cq.unit_of_measurement), ''), '?')) as unit,
           (cq.price / nullif(cq.case_size, 0))::double precision as client_unit_price
      from public.materials m
      join public.material_quotes cq on cq.id = m.current_quote_id
      left join public.users u on u.id = m.user_id
     where u.organization_id = $1::uuid
       and cq.price is not null and cq.price > 0
       and cq.case_size is not null and cq.case_size > 0
    `,
    [tenkaraOrgId]
  );

  const currentByKey = new Map<string, number>();
  for (const a of approved) currentByKey.set(`${a.material_id}|${a.unit}`, a.client_unit_price);

  // Iterate every material with market stats so a material still appears even
  // when the client hasn't entered a current-supply price — in that case we
  // benchmark against the market average instead of dropping it.
  const fallback = opts?.clientCostFallback;
  const out: ClientBenchmark[] = [];
  for (const stat of pulse) {
    const key = `${stat.material_id}|${stat.unit}`;
    let current = currentByKey.get(key);
    let source: "tenkara" | "po" | null = current != null ? "tenkara" : null;
    if (current == null && fallback?.has(key)) {
      current = fallback.get(key)!;
      source = "po";
    }
    const hasClient = current != null;
    const clientPrice = hasClient ? current! : stat.avg_unit_price;
    const span = stat.max_unit_price - stat.min_unit_price;
    const percentile = span <= 0 ? 0 : (clientPrice - stat.min_unit_price) / span;
    const vs_avg_pct =
      stat.avg_unit_price > 0 ? ((clientPrice - stat.avg_unit_price) / stat.avg_unit_price) * 100 : 0;
    const position: ClientBenchmark["position"] =
      vs_avg_pct > 5 ? "above_market" : vs_avg_pct < -5 ? "below_market" : "at_market";
    out.push({ ...stat, client_unit_price: clientPrice, has_client_price: hasClient, client_price_source: source, percentile, vs_avg_pct, position });
  }
  out.sort((x, y) => y.vs_avg_pct - x.vs_avg_pct);
  return out;
}
