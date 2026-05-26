-- Phase G3 — Agent 11 (Lead Scanner CSV Push) registration.
-- Hands off dropped/terminal leads from leads_in_flight to Andrew (Tenkara eng)
-- as a per-supplier CSV via Slack DM.
--
-- v1.0 trims (recorded in sessions/SESSION-04):
--   - dedup is supplier-level over a rolling 7-day window (no lead_id column yet)
--   - no Slack ✅-reaction listener (status flips to 'sent' and stays)
--   - no 24h/72h follow-up sweep
-- Session 05 will add `lead_id` to lead_scanner_exports and reconcile the
-- leads_in_flight.stage vocabulary; this agent's dedup query swaps to lead_id then.

-- Storage bucket for per-supplier CSVs. Service-role only; signed URLs for ops.
insert into storage.buckets (id, name, public)
values ('lead-scanner-csvs', 'lead-scanner-csvs', false)
on conflict (id) do nothing;

-- Register the agent. Manual-trigger only initially — no schedule_cron until
-- the first live test against Andrew's DM lands cleanly.
insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, prompt)
values (
  'agent-11-lead-scanner-csv-push',
  'Agent 11 - Lead Scanner CSV Push',
  'Daily per-supplier CSV handoff to Andrew (Tenkara eng). Reads dropped/terminal leads from leads_in_flight, groups by supplier, uploads a CSV to Supabase Storage, and posts a Slack DM with the signed link. Status tracked in lead_scanner_exports.',
  'embedded',
  false,
  true,
  null,
  null
)
on conflict (slug) do update set
  runtime = 'embedded',
  name = excluded.name,
  description = excluded.description;
