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

create table if not exists public.unmatched_inbound_events (
  id uuid primary key default gen_random_uuid(),
  message_id text not null,
  conversation_id text not null,
  org_id uuid references public.orgs(id),
  account_id text,
  recipient_email text,
  case_id uuid references public.cases(id),
  draft_reference_id uuid references public.draft_references(id),
  sender_email text not null,
  processing_token uuid,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, message_id)
);

alter table public.unmatched_inbound_events enable row level security;

create unique index if not exists unmatched_inbound_case_message_idx
  on public.cases (org_id, ((metadata->>'message_id')))
  where type = 'unmatched_inbound';

create unique index if not exists unmatched_inbound_draft_event_idx
  on public.draft_references (((metadata->>'unmatched_event_key')))
  where metadata->>'unmatched_event_key' is not null;

create trigger trg_touch_unmatched_inbound_events
  before update on public.unmatched_inbound_events
  for each row execute function public.touch_updated_at();
