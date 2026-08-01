-- A published marketplace price is always USD.
--
-- Two writers land in leads_in_flight.payload.marketplace_pull: the Agent 05
-- runtime (lead-price-pull.ts) and the operator-invoked browserbase-price-pull
-- skill. The runtime converts to USD and writes the code as a literal; the skill
-- passed the extractor's listed currency straight through, so a raw INR/EUR number
-- published as dollars -- Rs 149 read as $149 overstates by ~96x. Both now convert,
-- but the invariant lived only in a comment and a string literal, which is why a
-- second writer could miss it. It belongs here, where it is discoverable from the
-- table and unbypassable by a third writer (a script, a new agent, a backfill).
--
-- Scoped to 'pulled' rows: that is the only status carrying a price a surface will
-- render. A needs_manual_pull / pending row has no price, so its currency is moot.
--
-- NOT VALID, and validated separately in 0069. Kept apart because ADD CONSTRAINT
-- takes an ACCESS EXCLUSIVE lock: validating in the same transaction would hold
-- that lock across the full-table scan, which is the cost NOT VALID exists to
-- avoid. On its own this already enforces every INSERT and UPDATE -- it only skips
-- re-checking rows that already exist -- so an environment can adopt it before its
-- backfill has run and validate afterwards.

alter table public.leads_in_flight
  add constraint leads_in_flight_marketplace_pull_usd check (
    payload -> 'marketplace_pull' ->> 'status' is distinct from 'pulled'
    or coalesce(payload -> 'marketplace_pull' ->> 'currency', 'USD') = 'USD'
  ) not valid;
