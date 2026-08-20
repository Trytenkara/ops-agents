-- DATA-15: extraction records what it did not take.
--
-- Before this table a missed price left no trace at all. insertStagedQuotes is
-- only called when the extractor returned something, so a message it read as
-- priceless produced no row, no log line and no denominator — the extractor was
-- being measured with its own output, and three suppliers who quoted a price
-- (Shandong Depu usd1300/mt, Sinochem Nanjing USD1450/MT, Hefei TNJ usd1490/mt)
-- were simply absent from the data with nothing anywhere saying so.
--
-- One row per inbound message we read, written whether or not anything was
-- captured. price_points_present is the extractor's count of distinct price
-- points in the message, counting every rung of every ladder; rows_staged is
-- what actually landed. A shortfall between them is the miss signal, and the
-- reconcile columns hold the second read's verdict on it.
create table if not exists public.message_price_capture (
  message_id text primary key,
  conversation_id text,
  org_id uuid references public.orgs (id) on delete set null,
  supplier_name text,
  -- Deliberately a count, not a boolean. Foodchem stated three prices and we
  -- staged one; "did this message have a price" answers yes and re-checks
  -- nothing. Only a count has a shortfall.
  price_points_present integer,
  -- What the extractor handed the writer, before dedup and before the gates.
  quotes_extracted integer not null default 0,
  -- What the writer actually stored. Below quotes_extracted is usually dedup
  -- doing its job; below price_points_present is a miss.
  rows_staged integer not null default 0,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  -- Filled by the reconciliation agent. Null = not yet looked at.
  reconciled_at timestamptz,
  reconcile_verdict text check (reconcile_verdict in ('confirmed_miss', 'no_miss', 'unreadable')),
  reconcile_note text
);

comment on table public.message_price_capture is
  'One row per inbound supplier message read for prices, written even when nothing was captured (DATA-15). price_points_present > rows_staged is the miss signal the reconciliation agent works.';

-- The agent''s worklist: unreconciled rows that came up short.
create index if not exists message_price_capture_shortfall_idx
  on public.message_price_capture (received_at desc)
  where reconciled_at is null and price_points_present > rows_staged;
