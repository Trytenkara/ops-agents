-- Migration 0026 - register Agent 14 (QA Watchdog).
--
-- Data-integrity sweep over the other agents' outputs. Embedded runtime, like
-- the rest. Starts in training_wheels_mode so its first runs are flagged
-- "cautious" in the UI until we've watched a few digests land correctly.

insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, prompt)
values (
  'agent-14-qa-watchdog',
  'Agent 14 - QA Watchdog',
  'Data-integrity sweep over the other agents outputs: replies detected but not drafted, staged quotes missing price/material, low-confidence or stale review items, and recent agent failures. Flags issues to Slack; never mutates data.',
  'embedded',
  true,
  false,
  null,
  null
)
on conflict (slug) do update set
  runtime = 'embedded',
  name = excluded.name,
  description = excluded.description;
