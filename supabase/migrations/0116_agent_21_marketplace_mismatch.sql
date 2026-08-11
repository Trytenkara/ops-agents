-- Agent 21 — Marketplace Type Mismatch Watchdog
-- Tracks leads where source claims marketplace but the website is direct, or vice versa.
-- Posts daily as part of the sourcing health digest to the same Slack channel.

insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, schedule_tz)
  values (
    'agent-21-marketplace-mismatch',
    'Agent 21 — Marketplace Type Mismatch Watchdog',
    'Tracks leads where source claims marketplace but the website is direct, or vice versa. Catches routing misclassifications. Posted as part of daily sourcing health digest.',
    'embedded',
    false,
    false,
    '0 10 * * *',
    'Asia/Manila'
  )
  on conflict (slug) do update set
    schedule_cron = excluded.schedule_cron,
    schedule_tz = excluded.schedule_tz,
    runtime = excluded.runtime;
