-- What last moved a price, as opposed to when.
--
-- Since the 6-hourly FX pass restates the USD figure off a fresh rate, a price
-- can change with no page read and no supplier contact. That makes a bare
-- "updated 2h ago" ambiguous, and reading a restated number as a live quote is
-- exactly the mistake this column exists to prevent.
--
-- Values written today:
--   'supplier_quote'      captured from a supplier's reply
--   'fx_refresh'          restated at a new rate; nobody was asked anything
--   'marketplace_scrape'  (leads only, in payload.marketplace_pull.price_source)
alter table public.staged_quotes
  add column if not exists price_source text,
  add column if not exists price_source_at timestamptz;

-- NOT VALID: existing rows predate the column and are legitimately null. New and
-- updated rows must name a known writer rather than inventing a label.
do $$
begin
  alter table public.staged_quotes
    add constraint staged_quotes_price_source_known
    check (price_source is null or price_source in ('supplier_quote', 'fx_refresh', 'operator'))
    not valid;
exception
  when duplicate_object then null;
end $$;
