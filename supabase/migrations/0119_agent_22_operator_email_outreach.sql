-- Agent 22 — Operator Email Outreach.
-- Drafts a sourcing inquiry for every supplier email an operator hand-added.
-- Runs hourly so a hand-added address is acted on the same working day.
insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, schedule_tz)
values (
  'agent-22-operator-email-outreach',
  'Agent 22 — Operator Email Outreach',
  'Drafts a sourcing inquiry for every supplier email an operator hand-added. Matches an already-contacted supplier on the exact address only (never a shared mailbox domain), CCs the new contact onto a live thread rather than discarding them, and leaves any duplicate-record park untouched.',
  'embedded',
  false,
  false,
  '30 * * * *',
  'Asia/Manila'
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  schedule_cron = excluded.schedule_cron,
  schedule_tz = excluded.schedule_tz,
  runtime = excluded.runtime;
