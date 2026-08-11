-- Per-org pipeline cadence, moved out of Vercel env into the DB so ops can change
-- it in Control Room without a redeploy. Replaces MOTHERLODE_ORG_IDS.
--
--   testing        = 1-min discovery + 5-min outreach (internal test orgs only)
--   high_frequency = 15-min discovery/enrichment/outreach, 6h marketplace
--   normal         = 2h discovery, 1h enrichment/outreach, 24h marketplace
--
-- Named high_frequency, NOT motherlode: orgs.onboarding_stage already uses
-- 'motherlode' for something unrelated (the wide-net lead-quality bar). The two
-- were routinely confused because only the stage one was visible in the UI.
alter table orgs
  add column if not exists pipeline_tier text not null default 'normal'
  check (pipeline_tier in ('testing', 'high_frequency', 'normal'));

-- Seed from the env vars this replaces, so cadence is unchanged across the cutover.
-- MOTHERLODE_ORG_IDS = aurora, california-chemicals, saponiq
update orgs set pipeline_tier = 'high_frequency'
  where id in (
    '6ee3f433-fc6c-41a0-837c-72ebd9822bed',
    'bfb42d8c-7435-44ef-a914-91869b1e726b',
    '96552a6f-75cd-44c3-8557-d2ef19bfbdf8'
  );

-- FAST_TRACK_ORG_IDS = tenkara internal sourcing. Note that env var still governs
-- compressed reply/follow-up timers in lib/agent-timing.ts and is NOT retired here;
-- only its run-cadence role moves to this column.
update orgs set pipeline_tier = 'testing'
  where id = 'ce863603-3667-42f7-819d-d4f8a0087a27';
