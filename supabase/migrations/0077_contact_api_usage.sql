-- Contact-provider usage accounting for Settings > "API usage & cost".
--
-- Agent 06 now journals every paid contact-provider call (Hunter, LeadMagic,
-- ZoomInfo, GetProspect) into agent_run_events: step = provider slug,
-- level = 'info' (hit/miss) | 'warn' (quota/auth/error), data.units = billable
-- units consumed. Before this, a quota-exhausted provider was indistinguishable
-- from a provider that simply never found anything.

-- 0055 indexed only the two discovery steps. Widen it to cover the contact
-- providers so the usage counts stay index-only scans as the table grows.
drop index if exists agent_run_events_provider_usage_idx;
create index if not exists agent_run_events_provider_usage_idx
  on public.agent_run_events (step, level, at)
  where step in ('importyeti', 'sourceready', 'hunter', 'leadmagic', 'zoominfo', 'getprospect');

-- Billable units are summed, not counted: one Hunter call can reveal several
-- emails (1 credit each) and one ZoomInfo enrich call can bill several contacts.
-- Doing this in SQL also sidesteps the PostgREST 1000-row page cap, which would
-- silently truncate a client-side sum.
create or replace function public.contact_api_usage(since timestamptz default null)
returns table (
  provider text,
  calls bigint,
  units numeric,
  failed bigint
)
language sql
stable
as $$
  select
    step as provider,
    count(*) filter (where level = 'info') as calls,
    coalesce(sum((data->>'units')::numeric) filter (where level = 'info'), 0) as units,
    count(*) filter (where level = 'warn') as failed
  from public.agent_run_events
  where step in ('hunter', 'leadmagic', 'zoominfo', 'getprospect')
    and (since is null or at >= since)
  group by step;
$$;
