-- Operator-reported issues from the in-app "Report Issue" button. Each row is a
-- real-time bug report captured with the page the operator was on and their user
-- id. The agent triages these (auto-fix trivial UI, PR-gate anything backend,
-- bounce feature requests) and writes back classification + resolution + the PR
-- url so ops can see the loop close from the app. Idempotent.

create table if not exists public.issue_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.users(id),
  reporter_email text,
  title text not null,
  description text not null,
  page_path text,
  org_slug text,
  status text not null default 'new' check (status in ('new','triaging','auto_fixing','awaiting_approval','deployed','wont_fix')),
  classification text check (classification in ('trivial','gated','feature')),
  resolution text,
  pr_url text,
  slack_message_ts text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists issue_reports_status_idx on public.issue_reports (status);
create index if not exists issue_reports_created_at_idx on public.issue_reports (created_at desc);

alter table public.issue_reports enable row level security;

-- All reads and writes flow through authenticated server endpoints using the
-- service role. No direct client access prevents reporter data leaking across orgs.
drop policy if exists issue_reports_insert on public.issue_reports;
drop policy if exists issue_reports_select on public.issue_reports;

create or replace function public.create_issue_report(
  p_reporter_id uuid,
  p_reporter_email text,
  p_title text,
  p_description text,
  p_page_path text,
  p_org_slug text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_reporter_id is null then
    raise exception 'issue_report_reporter_required' using errcode = '22004';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_reporter_id::text, 0));
  if (select count(*) from public.issue_reports where reporter_id = p_reporter_id and created_at >= now() - interval '1 minute') >= 3 then
    raise exception 'issue_report_rate_limited' using errcode = 'P0001';
  end if;
  insert into public.issue_reports (reporter_id, reporter_email, title, description, page_path, org_slug)
  values (p_reporter_id, p_reporter_email, p_title, p_description, p_page_path, p_org_slug)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.create_issue_report(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_issue_report(uuid, text, text, text, text, text) to service_role;
