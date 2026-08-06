-- When the SUPPLIER last actually repriced, as distinct from when the row was
-- last written.
--
-- The FX pass restates USD prices on a schedule (moving to hourly), so
-- price_source_at answers "when did this number last change" with "an hour ago"
-- on almost every foreign-listed row, forever. That is true and useless: it
-- cannot tell you whether the seller has moved in three months.
--
-- This column is stamped only when the split attributes the move to the supplier
-- ('supplier' or 'both') and is carried forward untouched through every rate
-- restatement in between.
alter table public.staged_quotes
  add column if not exists supplier_price_changed_at timestamptz;

-- Existing quotes: the row's own creation IS a supplier price statement (a quote
-- arriving is the supplier stating a number), and nothing has restated it since
-- except FX, which does not count. So created_at is the honest answer here, not a
-- guess.
update public.staged_quotes
  set supplier_price_changed_at = created_at
  where supplier_price_changed_at is null;
