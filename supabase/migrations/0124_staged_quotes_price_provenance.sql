-- DATA-14: a captured price carries the words it was read from.
--
-- The extractor returns the verbatim fragment of the supplier's message each
-- price was read out of, and insertStagedQuotes verifies the amount and the
-- unit both appear in it before the price is publishable. Katonah's
-- "Drums are 518lbs at 1.1975/lb" was stored as 620.5410 USD/lb (the unit price
-- times the drum weight) and passed every gate we had, because the gates only
-- ever looked at the number in isolation.
--
-- Nullable on purpose: history predates the column, and a null here means
-- "captured before provenance was required", not "verified empty". New rows
-- with a price and no fragment are withheld and flagged by the writer.
alter table public.staged_quotes
  add column if not exists price_source_text text;

comment on column public.staged_quotes.price_source_text is
  'Verbatim fragment of the supplier message this price was read from (DATA-14). The stored amount and unit must both appear in it; the writer withholds the price and flags the row when they do not. Null on rows captured before 0124.';

-- Review surfaces filter to the rows a human still has to judge, and the
-- unverifiable ones are exactly that set.
create index if not exists staged_quotes_missing_provenance_idx
  on public.staged_quotes (org_id)
  where price is not null and price_source_text is null;
