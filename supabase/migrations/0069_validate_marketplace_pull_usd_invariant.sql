-- Certify the existing rows against the invariant added in 0068.
--
-- Separate migration so this runs in its own transaction: ADD CONSTRAINT holds an
-- ACCESS EXCLUSIVE lock, and validating alongside it would hold that lock for the
-- whole scan. VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE, so reads and
-- writes continue while it runs.
--
-- Requires the pre-fix rows to have been restated to USD first; until then the
-- 0068 constraint still blocks new foreign-currency writes on its own.

alter table public.leads_in_flight
  validate constraint leads_in_flight_marketplace_pull_usd;
