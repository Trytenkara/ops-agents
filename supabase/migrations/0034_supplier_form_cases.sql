-- Supplier forms as escalations. When a supplier emails a form to fill/sign
-- (credit reference, new-account/vendor setup, W-9, NDA, banking), Agent 15
-- opens a 'supplier_form' case, stores the file in a private bucket, and records
-- the form type for ops. Idempotent.

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
    'other'
  ])
);

-- Private bucket for supplier-sent form attachments. Downloads are gated by an
-- authenticated app route that mints short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('supplier-forms', 'supplier-forms', false)
on conflict (id) do nothing;
