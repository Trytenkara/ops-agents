-- Per-invocation isolation fix (May 2026).
--
-- /api/cron now dispatches each due agent to its OWN ?slug= invocation, so a
-- heavy agent can't time out / kill the others sharing one function. For that
-- to work, 04 (Outreach) and 06 (Enrichment) must be scheduled again (each runs
-- isolated) rather than driven inline by Agent 03 — inlining them in 03 blew the
-- 300s budget. 10 (QA) stays unscheduled: it runs inline at draft creation.
--
-- Staggered off the :00 top-of-hour pile-up (01/02/05/08) to spread load.

update public.agents set schedule_cron = '5,35 * * * *',  schedule_tz = 'America/New_York' where slug = 'agent-06-enrichment';
update public.agents set schedule_cron = '20,50 * * * *', schedule_tz = 'America/New_York' where slug = 'agent-04-outreach';
-- agent-10-qa-outreach stays NULL (runs inline via the shared draft-staging pipeline).
