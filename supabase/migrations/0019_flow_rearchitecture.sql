-- Flow re-architecture (May 2026): turn 04/06/10 into called sub-steps and
-- retime the intake agents. See docs/AGENTS-OVERVIEW.md.
--
-- Deliberate deviations from the spec:
--   - Agent 01 stays frequent (liveness probe; twice-daily would hide outages).
--   - Agent 08 stays frequent (inbound replies shouldn't wait ~24h for a draft).

-- Intake agents: retimed.
update public.agents set schedule_cron = '0 7 * * *'      where slug = 'agent-02-revalidation';      -- daily 07:00 (was weekly Mon)
update public.agents set schedule_cron = '0 7-21/2 * * *' where slug = 'agent-03-lead-creator';       -- every 2h, 07:00–21:00 (was every 4h)
update public.agents set schedule_cron = '0 14 * * *'     where slug = 'agent-07-escalation';         -- daily 14:00 (was every 6h)

-- Building blocks: no longer independently scheduled. Agent 03 drives 06 then 04;
-- 02/03/08 run 10's lint inline via the shared staging pipeline. NULL schedule
-- means the cron dispatcher skips them; they remain manually triggerable
-- (/api/cron?slug=…) for backfill.
update public.agents set schedule_cron = null where slug = 'agent-04-outreach';
update public.agents set schedule_cron = null where slug = 'agent-06-enrichment';
update public.agents set schedule_cron = null where slug = 'agent-10-qa-outreach';

-- Paused.
update public.agents set training_wheels = true where slug = 'agent-11-lead-scanner-csv-push';

-- Unchanged (kept deliberately): agent-01-ping (*/5), agent-05-marketplace-validation (0 7),
-- agent-08-email-scanner (*/30), agent-fleet-summary (0 18).
