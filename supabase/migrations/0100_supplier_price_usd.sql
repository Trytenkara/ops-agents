-- The price with exchange-rate movement taken back out.
--
-- 0099 records WHY a price moved and by how much on each side. That is enough to
-- triage but not enough to act on: when the verdict is 'both', the headline price
-- mixes the seller's reprice with rate drift, and a platform quote reissued off
-- it would bake FX noise into a contract number. This column is the figure to
-- reissue from, and it is a plain price so it can be pulled directly rather than
-- reconstructed from a delta.
--
-- Marketplace tier: the current listing valued at the previous read's rate, so
--   previous price + supplier_delta_usd = supplier_price_usd exactly.
-- Direct quote: the capture-time price, since a supplier cannot reprice inside an
--   existing row (a reprice arrives as a new quote) and every dollar the row has
--   moved since is the rate's doing.
alter table public.staged_quotes
  add column if not exists supplier_price_usd numeric(14,4);
