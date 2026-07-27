-- Per-org, per-agent last-processed timestamp table for tier-based throttling.
-- Each agent checks this table to decide whether a given org is "due" for
-- processing based on its tier (testing / motherlode / normal).
CREATE TABLE IF NOT EXISTS agent_org_timing (
  agent_slug text NOT NULL,
  org_id     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_slug, org_id)
);

-- Agents read/write this frequently; index the org_id direction too.
CREATE INDEX IF NOT EXISTS agent_org_timing_org_id_idx ON agent_org_timing (org_id);
