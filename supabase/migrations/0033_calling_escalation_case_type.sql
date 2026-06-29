-- Add a 'calling_escalation' case type. Agent 15 opens one of these when a
-- supplier stays silent after both no-reply email follow-ups, so a call
-- operator can phone them. Idempotent: drop + re-add the check constraint.

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
    'other'
  ])
);
