-- Agent 08 was two things: a Missive inbox poll on a 30-min cron, and the Tenkara
-- inbound webhook. The Missive cutover made the poll a no-op, and the embedded
-- registration has now been deleted, so the cron would call an unregistered slug
-- and log a failure every 30 minutes. Drop the schedule; the webhook is the agent.
-- The row itself stays: draft_references and agent_runs reference its id, and the
-- webhook still stamps inbound work with it.
update agents
set schedule_cron = null,
    status = 'disabled'
where slug = 'agent-08-email-scanner';
