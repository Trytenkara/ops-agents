-- Backlog #13: an inbound supplier/client reply that our webhook handler cannot
-- tie to any originating outreach (no draft_id, thread_id, sender-domain, or
-- exact-address match) is now RECORDED for operator triage instead of being
-- silently dropped. When we can resolve the client, tenkara-inbound opens an
-- 'unmatched_inbound' case; add it to the allowed case types.
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
    'unmatched_inbound',
    'other'
  ])
);
