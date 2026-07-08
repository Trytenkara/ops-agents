-- Manual-outreach cases. When a discovered supplier has no usable email but we
-- DID find a contact channel (a quote/RFQ form or a marketplace inquiry path),
-- Agent 04 opens a 'manual_outreach' case with the ready-to-paste RFQ text so an
-- operator can reach out through that channel instead of the lead being dropped.
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
    'other'
  ])
);
