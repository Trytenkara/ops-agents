-- Agent 23 - Org Isolation Audit.
-- The detection half of org isolation. The guards in src/lib/org-isolation.ts
-- and scripts/check-rules.mjs stop the mistakes we already know about; this
-- reads the live data every morning and reports one client's records showing up
-- under another client's name. Read-only, alerts into the feedback channel, and
-- stays quiet when there is nothing to say.
--
-- 06:00 Manila is before the drafting agents start their day, so a fault found
-- overnight is on the channel before more drafts are built on top of it.
insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, schedule_tz)
values (
  'agent-23-org-isolation-audit',
  'Agent 23 - Org Isolation Audit',
  'Nightly read-only sweep for cross-client contamination: conversations or drafts shared by two clients, colliding reference keys, draft copy naming the wrong client, and supplier replies parked with no client. Reports to the feedback channel and never repairs, because deciding whose a record is needs a human.',
  'embedded',
  false,
  false,
  '0 6 * * *',
  'Asia/Manila'
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  schedule_cron = excluded.schedule_cron,
  schedule_tz = excluded.schedule_tz,
  runtime = excluded.runtime;
