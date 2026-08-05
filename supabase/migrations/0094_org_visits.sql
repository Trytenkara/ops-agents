-- Per-operator "most frequently used" signal for the sidebar client quick-list.
--
-- Bucketed by day rather than one row per page view: growth is bounded to
-- users x orgs x days, and the day column is what lets the sidebar score a
-- trailing window (an org someone lived in six months ago should not outrank
-- the one they open every morning).
create table if not exists public.org_visits (
  user_id uuid not null references public.users(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  visit_day date not null default current_date,
  hits int not null default 0,
  primary key (user_id, org_id, visit_day)
);
create index if not exists org_visits_user_day_idx on public.org_visits(user_id, visit_day desc);

alter table public.org_visits enable row level security;
drop policy if exists org_visits_read on public.org_visits;
create policy org_visits_read on public.org_visits
  for select to authenticated using (user_id = auth.uid());

-- PostgREST upsert can't express `hits = hits + 1`, hence the RPC.
create or replace function public.record_org_visit(p_user_id uuid, p_org_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.org_visits (user_id, org_id, visit_day, hits)
  values (p_user_id, p_org_id, current_date, 1)
  on conflict (user_id, org_id, visit_day)
  do update set hits = org_visits.hits + 1;
$$;

revoke all on function public.record_org_visit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_org_visit(uuid, uuid) to service_role;
