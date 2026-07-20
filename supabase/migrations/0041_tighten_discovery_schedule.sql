-- #1 timing. Ops flagged that outreach drafts lag and don't run overnight. The
-- lag is the discovery step: Agent 03 ran only every 2h during 07:00–21:00, so a
-- material added in the evening/overnight waited until morning to be picked up.
-- Outreach (agent-04, :20/:50) and enrichment (agent-06, :05/:35) already run
-- twice-hourly around the clock, so tightening discovery to hourly + overnight
-- closes the gap end-to-end.
update public.agents
   set schedule_cron = '0 * * * *', schedule_tz = 'America/New_York'
 where slug = 'agent-03-lead-creator';
