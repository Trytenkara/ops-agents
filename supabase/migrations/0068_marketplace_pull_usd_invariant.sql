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
-- Added NOT VALID and validated in the same step: the 34 rows written before the
-- skill was fixed were restated to USD first, so validation passes over the whole
-- table. NOT VALID on its own would still enforce every INSERT and UPDATE -- it
-- only skips re-checking existing rows -- so the two statements can be split if a
-- future environment needs to adopt the constraint ahead of its backfill.

alter table public.leads_in_flight
  add constraint leads_in_flight_marketplace_pull_usd check (
    payload -> 'marketplace_pull' ->> 'status' is distinct from 'pulled'
    or coalesce(payload -> 'marketplace_pull' ->> 'currency', 'USD') = 'USD'
  ) not valid;

alter table public.leads_in_flight
  validate constraint leads_in_flight_marketplace_pull_usd;
