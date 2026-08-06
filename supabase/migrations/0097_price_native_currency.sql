-- Keep the listed (native) price next to the published USD one.
--
-- Every price surface publishes USD, converting foreign listings on the way in.
-- Both writers threw the original away: the marketplace pull discarded it
-- outright, and the staged-quote writer kept it only as English prose in
-- extraction_notes ("Converted from INR to USD @ 0.0119 (was INR 8700 ...)").
-- Neither is arithmetic, so a USD price moving from 100 to 105 was
-- unattributable: the seller repricing and the rupee moving looked identical.
--
-- ~20% of priced leads are foreign-listed (IndiaMART, TradeIndia,
-- ExportersIndia), so this is not an edge case. Storing native amount + the rate
-- used makes the split exact (see src/lib/price-delta.ts) and lets a cheap
-- arithmetic pass restate USD on an FX cadence without re-reading any page.
--
-- The marketplace/aggregator side needs no DDL: those live in
-- leads_in_flight.payload (jsonb). Only staged_quotes has real columns.
--
-- Note unit_price is GENERATED from price, so it follows an FX restatement
-- automatically and needs no native counterpart.

alter table public.staged_quotes
  -- Amount exactly as the supplier quoted it, before conversion. Null when the
  -- quote arrived in USD, where price is already the native figure.
  add column if not exists native_price numeric(14,4),
  add column if not exists native_currency text,
  -- USD per 1 unit of native_currency, at the moment price was last computed.
  -- The FX refresh moves this; it is "the rate `price` currently reflects".
  add column if not exists fx_rate numeric(18,8),
  add column if not exists fx_rate_at timestamptz,
  -- Frozen at capture and never rewritten. `price` floats with the rate, so
  -- without a fixed anchor a quote's currency exposure is unmeasurable: the
  -- moment you restate both sides at today's rate, the drift cancels to zero.
  -- These give the Direct tab its currency delta ("this supplier's quote is
  -- worth $X less than when they sent it") independently of the supplier delta
  -- ("they quoted a different number than last time").
  add column if not exists captured_price numeric(14,4),
  add column if not exists captured_fx_rate numeric(18,8);

-- Either fully native-tagged or not tagged at all. A row carrying a native
-- amount without the rate that produced its USD figure cannot be decomposed and
-- would render a silently wrong currency delta.
alter table public.staged_quotes
  add constraint staged_quotes_native_complete check (
    native_price is null
    or (native_currency is not null and fx_rate is not null and fx_rate > 0)
  ) not valid;

-- Partial: only foreign-listed rows are ever swept by the FX refresh, and they
-- are the minority.
create index if not exists staged_quotes_native_currency_idx
  on public.staged_quotes (native_currency)
  where native_currency is not null and native_currency <> 'USD';
