-- Agent 05 attempts to auto-pull a marketplace supplier's listed price for newly
-- discovered leads. When the price can't be pulled (login/paywall, broken link,
-- or nothing found) it opens a 'marketplace_price_pull' case assigned to the
-- lead's operator so someone fetches the price manually.
alter table public.cases drop constraint if exists cases_type_check;
alter table public.cases add constraint cases_type_check check (
  type = any (array[
    'price_change',
    'lead_time_change',
    'availability_change',
    'quality_change',
    'po_timing',
    'client_info_request',
    'archive_request',
    'calling_escalation',
    'supplier_form',
    'manual_outreach',
    'marketplace_price_pull',
    'other'
  ])
);
