-- Whether a marketplace listing can actually be bought, and since when.
--
-- Agent 05 has always been told to read stock status off the page, but had
-- nowhere to put it: a sold-out listing that still printed a number published as
-- a live price, and one that hid its price behind the sold-out state was filed as
-- needs_review and retried forever as if it were a scrape failure.
--
-- out_of_stock_since is the FIRST observation of the current unavailability, not
-- the latest. Each finding is one observation, so a per-row "as of now" stamp
-- would reset on every re-check and could never answer "how long has this been
-- gone" — which is the question that decides whether to drop the supplier.
-- Null whenever stock_status is null or 'in_stock'.
--
-- Leads carry the same three fields in leads_in_flight.payload.marketplace_pull
-- (jsonb, no DDL needed): stock_status, stock_note, stock_checked_at,
-- out_of_stock_since.
alter table public.marketplace_check_findings
  add column if not exists stock_status text,
  add column if not exists stock_note text,
  add column if not exists out_of_stock_since timestamptz;

-- NOT VALID: existing rows predate the column and are legitimately null (the
-- page was never asked). New rows must name a known verdict rather than
-- inventing a label. null means the page said nothing, which is NOT 'in_stock'.
do $$
begin
  alter table public.marketplace_check_findings
    add constraint marketplace_check_findings_stock_status_known
    check (stock_status is null or stock_status in ('in_stock', 'out_of_stock', 'discontinued'))
    not valid;
exception
  when duplicate_object then null;
end $$;

-- The sold-out set is small and read on every price-index render; findings are not.
create index if not exists marketplace_check_findings_out_of_stock_idx
  on public.marketplace_check_findings (quote_id, created_at desc)
  where stock_status is not null;
