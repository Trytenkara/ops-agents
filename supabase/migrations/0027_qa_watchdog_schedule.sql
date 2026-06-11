-- Migration 0027 - schedule Agent 14 (QA Watchdog).
--
-- Daily at 16:00 America/New_York: late enough that the day's email-scanner,
-- marketplace, and outreach runs have produced staged quotes / findings to
-- check, and before the 18:00 fleet summary. Times are in agents.schedule_tz.

update public.agents
   set schedule_cron = '0 16 * * *',
       schedule_tz = 'America/New_York'
 where slug = 'agent-14-qa-watchdog';
