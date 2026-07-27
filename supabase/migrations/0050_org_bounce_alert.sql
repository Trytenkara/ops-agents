-- Bounce alert tracking for outreach deliverability protection.
-- When we detect 2+ consecutive bounces from a client's domain/sending address,
-- alert ops and pause outreach until they manually clear the alert.
alter table orgs
  add column if not exists bounce_alert_status text not null default 'none'
  check (bounce_alert_status in ('none', 'triggered', 'paused_by_ops'));

-- Track bounce events per client (org_id).
-- Consecutive bounces = bounces within the alert window without intervening replies.
create table if not exists bounce_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  supplier_id uuid,
  bounce_type text not null, -- 'mailer_daemon', 'delivery_failure', 'rate_limit', 'dns_block', 'other'
  detected_at timestamp not null default now(),
  message text, -- error message from bounce, for ops context
  created_at timestamp not null default now()
);

create index if not exists bounce_events_org_detected on bounce_events(org_id, detected_at desc);
