-- One flat, queryable surface for "what is this price and why did it last move".
--
-- The fields exist but not in one place you can select from. Direct quotes are
-- real columns on staged_quotes; marketplace and aggregator prices live inside
-- leads_in_flight.payload->price_tiers as jsonb, so pulling them meant knowing
-- the payload shape and hand-writing a lateral join. That is not a column anyone
-- can be pointed at, and marketplace listings are exactly where the foreign
-- currencies (and therefore the 'both' rows) are.
--
-- supplier_price_usd is the column to reissue platform quotes from: the price
-- with exchange-rate movement taken back out. On a 'currency' row it equals the
-- price already; on 'both' it is the only figure that isolates the seller's move.
-- security_invoker: both base tables have RLS. Without this the view runs as its
-- owner and quietly hands every org's prices to any authenticated caller, which
-- is a cross-tenant leak, not a convenience.
create or replace view public.price_provenance with (security_invoker = true) as
  select
    'direct'::text                          as price_kind,
    q.id::text                              as row_id,
    q.org_id,
    -- Cast: leads_in_flight stores these as text, staged_quotes as uuid.
    q.supplier_id::text                     as supplier_id,
    q.supplier_name,
    q.material_id::text                     as material_id,
    q.material_name,
    q.unit_of_measurement                   as pack_size,
    q.price                                 as price_usd,
    -- Null for rows written before this shipped. Falls back to the capture
    -- anchor, which IS the supplier-only price by definition, so the column is
    -- never silently null on a row we can actually answer for.
    coalesce(q.supplier_price_usd, q.captured_price, q.price) as supplier_price_usd,
    q.supplier_delta_usd,
    q.currency_delta_usd,
    q.price_change_source,
    q.supplier_price_changed_at,
    q.price_source,
    q.price_source_at,
    q.native_price,
    q.native_currency,
    q.fx_rate,
    q.status,
    q.created_at
  from public.staged_quotes q
  where q.material_id is not null

  union all

  select
    'marketplace'::text                     as price_kind,
    l.id::text || ':' || (t.ord - 1)::text  as row_id,
    l.org_id,
    l.supplier_id::text                     as supplier_id,
    l.supplier_name,
    l.material_id::text                     as material_id,
    l.material_name,
    t.tier->>'pack_size'                    as pack_size,
    nullif(t.tier->>'price', '')::numeric   as price_usd,
    nullif(t.tier->>'supplier_price_usd', '')::numeric  as supplier_price_usd,
    nullif(t.tier->>'supplier_delta_usd', '')::numeric  as supplier_delta_usd,
    nullif(t.tier->>'currency_delta_usd', '')::numeric  as currency_delta_usd,
    t.tier->>'price_change_source'          as price_change_source,
    nullif(t.tier->>'supplier_price_changed_at', '')::timestamptz as supplier_price_changed_at,
    t.tier->>'price_source'                 as price_source,
    nullif(t.tier->>'price_source_at', '')::timestamptz as price_source_at,
    nullif(t.tier->>'native_price', '')::numeric        as native_price,
    t.tier->>'native_currency'              as native_currency,
    nullif(t.tier->>'fx_rate', '')::numeric as fx_rate,
    l.status,
    l.created_at
  from public.leads_in_flight l
  cross join lateral jsonb_array_elements(l.payload->'price_tiers') with ordinality as t(tier, ord)
  -- Same two exclusions the Price Index applies. A retired lead's price is not a
  -- price on file, and a lead since re-judged as having no checkout leaves stale
  -- tiers that nothing will ever refresh or clear.
  where l.status = 'active'
    and coalesce(l.payload->'marketplace_pull'->>'status', '') <> 'not_marketplace'
    and jsonb_typeof(l.payload->'price_tiers') = 'array';

comment on view public.price_provenance is
  'Every current price with why it last moved. price_change_source in (supplier, currency, both, none); supplier_price_usd is the price with exchange-rate movement removed, i.e. what to reissue a platform quote from.';

-- Existing quotes predate the column but their supplier-only price is knowable:
-- nothing has repriced inside the row, so it is the capture anchor (or the price
-- itself for a USD quote that never had drift to anchor).
update public.staged_quotes
  set supplier_price_usd = coalesce(captured_price, price)
  where supplier_price_usd is null and price is not null;
