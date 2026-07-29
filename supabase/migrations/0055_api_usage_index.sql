-- Speeds up the Settings > "API usage & cost" counts, which filter
-- agent_run_events by the two discovery-provider steps. The table grows
-- unbounded and only has a (run_id, at) index, so provider counts would
-- otherwise seq-scan the whole table. This partial index stays tiny because
-- it only covers the two provider steps.
create index if not exists agent_run_events_provider_usage_idx
  on public.agent_run_events (step, level, at)
  where step in ('importyeti', 'sourceready');
