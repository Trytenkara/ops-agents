-- Migration 0067 - quote_profiles: marketplace checkout link + material density
--
-- Two additive feature columns on the quote-level validation table (0057):
--   1. source_url    - the marketplace/checkout/product link the quote came
--                      from. Already lived on leads_in_flight.payload but was
--                      dropped at the quote level (only survived as free text in
--                      purchasing_notes). Now a first-class, clickable field.
--   2. density (+unit/source) - material density / specific gravity per quote.
--                      Enables volume->weight conversion for freight and honest
--                      unit-price comparison across L/gal/kg pack sizes. Never
--                      fabricated: auto-retrieval writes a value only with a
--                      source_url in density_source, else leaves it null.

alter table public.quote_profiles
  add column if not exists source_url text,
  add column if not exists density numeric(12,5),
  add column if not exists density_unit text default 'g/ml',
  add column if not exists density_source text;
