-- Phase G3 prep — apply consistent `Agent NN - Name` naming convention.
-- Numbering reflects registration order, not phase/priority.

-- Agent 01 — Ping: rename slug + name + description.
update public.agents
set
  slug = 'agent-01-ping',
  name = 'Agent 01 - Ping',
  description = 'Infrastructure heartbeat agent. Runs on a schedule and POSTs to /api/runs to verify the SuperAgent ↔ Ops Assistants pipeline is intact. No real workflow logic. Used as the system liveness check.'
where slug = 'ping';

-- Agent 02 — Quote Revalidation: normalize em-dash to hyphen for consistency.
update public.agents
set name = 'Agent 02 - Quote Revalidation'
where slug = 'agent-02-revalidation';
