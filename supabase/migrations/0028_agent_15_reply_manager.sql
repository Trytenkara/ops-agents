-- Migration 0028 - register Agent 15 (Supplier Reply Manager).
--
-- Owns the supplier conversation after Agent 08 detects a reply: classifies the
-- reply and drafts the right next message (answer / reframe a no-record reply as
-- a fresh pricing ask / nudge for the missing price), staged in Missive for a
-- human to send. Light persistence (one follow-up), then hands stale threads to
-- ops. Maintains draft_references.metadata.flow_status so the Pricing Pipeline
-- board can track each thread to a finalized price. Never sends.
--
-- Runs every 30 min, just after Agent 08. training_wheels_mode=true until we've
-- watched a few response drafts land correctly.

insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, schedule_tz, prompt)
values (
  'agent-15-reply-manager',
  'Agent 15 - Supplier Reply Manager',
  'Owns the supplier conversation after a reply is detected: classifies the reply and drafts the right next message (answer, reframe a no-record reply as a fresh pricing ask, or nudge for the missing price), staged in Missive for a human to send. Light persistence (1 follow-up). Tracks flow_status to a finalized price. Never sends.',
  'embedded',
  true,
  false,
  '15,45 * * * *',
  'America/New_York',
  null
)
on conflict (slug) do update set
  runtime = 'embedded',
  name = excluded.name,
  description = excluded.description;
