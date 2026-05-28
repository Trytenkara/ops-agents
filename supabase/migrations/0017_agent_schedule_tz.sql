-- Per-agent timezone for schedule_cron interpretation + training_wheels kill switch.
-- The cron fan-out endpoint (/api/cron) parses each agent's cron in this tz
-- instead of a hardcoded America/New_York, and skips agents with training_wheels=true
-- so a single SQL UPDATE (or the "Halt All Agents" button) can pause the fleet.

alter table public.agents
  add column if not exists schedule_tz text not null default 'Asia/Manila';

alter table public.agents
  add column if not exists training_wheels boolean not null default false;

comment on column public.agents.training_wheels is
  'When true, /api/cron skips this agent. Used as a kill switch for runaway behavior. Agent 01 (Ping) is exempt by convention so the heartbeat keeps proving the runtime is reachable.';

-- Cron cadences. All times in agents.schedule_tz (default Asia/Manila for ops team).
-- The 5-min fan-out endpoint is what actually fires; these decide which agents run when.

update public.agents
  set schedule_cron = '*/5 * * * *', schedule_tz = 'Asia/Manila'
  where slug = 'agent-01-ping';

update public.agents
  set schedule_cron = '0 6 * * 1', schedule_tz = 'Asia/Manila'
  where slug = 'agent-02-revalidation';

update public.agents
  set schedule_cron = '0 */4 * * *', schedule_tz = 'Asia/Manila'
  where slug = 'agent-03-lead-creator';

update public.agents
  set schedule_cron = '0 * * * *', schedule_tz = 'Asia/Manila'
  where slug = 'agent-04-outreach';

update public.agents
  set schedule_cron = '0 7 * * *', schedule_tz = 'Asia/Manila'
  where slug = 'agent-05-marketplace-validation';

update public.agents
  set schedule_cron = '0 */2 * * *', schedule_tz = 'Asia/Manila'
  where slug = 'agent-06-enrichment';

update public.agents
  set schedule_cron = '0 */6 * * *', schedule_tz = 'Asia/Manila'
  where slug = 'agent-07-escalation';

update public.agents
  set schedule_cron = '*/30 * * * *', schedule_tz = 'Asia/Manila'
  where slug = 'agent-08-email-scanner';

update public.agents
  set schedule_cron = '15 * * * *', schedule_tz = 'Asia/Manila'
  where slug = 'agent-10-qa-outreach';

update public.agents
  set schedule_cron = '0 6 * * *', schedule_tz = 'America/Los_Angeles'
  where slug = 'agent-11-lead-scanner-csv-push';

-- Register fleet-summary agent (daily 18:00 Manila DM to Sam).
insert into public.agents (slug, name, description, runtime, schedule_cron, schedule_tz)
  values (
    'agent-fleet-summary',
    'Fleet Summary',
    'Daily 6pm summary DM to Sam with run totals across the fleet.',
    'embedded',
    '0 18 * * *',
    'Asia/Manila'
  )
  on conflict (slug) do update set
    schedule_cron = excluded.schedule_cron,
    schedule_tz = excluded.schedule_tz,
    runtime = excluded.runtime;
