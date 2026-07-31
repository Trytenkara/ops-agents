alter table public.leads_in_flight
  add column if not exists outreach_approved_at timestamptz,
  add column if not exists outreach_approved_by uuid references public.users(id),
  add column if not exists outreach_reject_reason text;

create index if not exists leads_marketplace_outreach_review_idx
  on public.leads_in_flight (org_id, created_at)
  where status = 'active' and stage = 'ready_for_approval';
