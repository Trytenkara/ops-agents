-- Per-org sourcing pause switch (Control Room). Replaces the env-only ONLY_ORG
-- scoping with a live, per-org 3-way control operators can toggle without a deploy:
--   active        = full pipeline (discovery, enrichment, outreach, replies, re-quote)
--   sourcing_only = discovery + enrichment build the supplier pool; outreach/replies held
--   off           = agents skip this org entirely
-- Default 'off' so a newly-synced org stays parked until ops turns it on.
alter table orgs
  add column if not exists sourcing_status text not null default 'off'
  check (sourcing_status in ('active', 'sourcing_only', 'off'));

-- Seed current reality (2026-07-24): Sierra live, California discovery-only, rest parked.
update orgs set sourcing_status = 'active'        where name = 'Tenkara (Internal Sourcing)';
update orgs set sourcing_status = 'sourcing_only' where name = 'California Chemicals';
