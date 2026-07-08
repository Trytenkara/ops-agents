-- Operator-reported issues from the in-app "Report Issue" button. Each row is a
-- real-time bug report captured with the page the operator was on and their user
-- id. The agent triages these (auto-fix trivial UI, PR-gate anything backend,
-- bounce feature requests) and writes back classification + resolution + the PR
-- url so ops can see the loop close from the app. Idempotent.

create table if not exists public.issue_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.users(id),
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

-- Any authenticated operator can file a report and read reports. Writes that
-- change status/classification/resolution happen through the service-role agent
-- endpoints, which bypass RLS.
drop policy if exists issue_reports_insert on public.issue_reports;
create policy issue_reports_insert on public.issue_reports
  for insert to authenticated with check (true);

drop policy if exists issue_reports_select on public.issue_reports;
create policy issue_reports_select on public.issue_reports
  for select to authenticated using (true);
