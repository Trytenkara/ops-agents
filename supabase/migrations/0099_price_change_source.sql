-- WHY a price last changed, alongside what changed it (0098's price_source).
--
-- These answer different questions and both are needed. price_source names the
-- writer ('fx_refresh' vs 'marketplace_scrape'); price_change_source names the
-- cause, and the cause is what decides downstream action: a supplier reprice
-- means the quote we are holding is stale and has to be reissued, while pure
-- exchange-rate drift means the seller still stands behind the same number and
-- the quote is fine.
--
-- The two amounts are stored beside it so a consumer never re-derives the split
-- convention (see splitPriceDelta in src/lib/price-delta.ts) and cannot drift
-- out of agreement with what the UI shows.
alter table public.staged_quotes
  add column if not exists price_change_source text,
  add column if not exists supplier_delta_usd numeric(14,4),
  add column if not exists currency_delta_usd numeric(14,4);

-- NOT VALID: rows written before this column are legitimately null, meaning
-- "never evaluated" rather than "nothing changed". 'none' is the distinct claim
-- that we looked and the price held.
do $$
begin
  alter table public.staged_quotes
    add constraint staged_quotes_price_change_source_known
    check (price_change_source is null or price_change_source in ('supplier', 'currency', 'both', 'none'))
    not valid;
exception
  when duplicate_object then null;
end $$;
