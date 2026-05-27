-- Migration 0015 - register Agent 08 (Email Scanner) + create agent_state.
--
-- agent_state is a generic cursor / per-agent K/V store. Agent 08 uses it to
-- track the last Missive last_activity_at it scanned through, so re-runs
-- don't reprocess conversations. Other agents can use it too.

create table if not exists public.agent_state (
  agent_id uuid not null references public.agents(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (agent_id, key)
);

create index if not exists agent_state_updated_idx on public.agent_state(updated_at);

do $$
begin
  drop trigger if exists trg_touch_agent_state on public.agent_state;
  create trigger trg_touch_agent_state before update on public.agent_state
    for each row execute function public.touch_updated_at();
end$$;

-- training_wheels_mode=true: this is the first agent that reads inbox state,
-- and we want operators to see runs flagged as "cautious" in the UI until
-- we've watched a few real replies land correctly.
insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, prompt)
values (
  'agent-08-email-scanner',
  'Agent 08 - Email Scanner',
  'Scans the Missive team_inbox for messages from supplier addresses we have outreach to. Matches by sender email (not thread id) so fresh chains from suppliers are still caught. Flags replies onto draft_references and leads_in_flight; never sends.',
  'embedded',
  true,
  true,
  null,
  null
)
on conflict (slug) do update set
  runtime = 'embedded',
  name = excluded.name,
  description = excluded.description;
