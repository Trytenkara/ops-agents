-- Park marketplace leads that Agent 04 can never cold-email, so they stop
-- occupying its fetch window.
--
-- Agent 04 pulls only the newest `maxDrafts * N` enriched leads (created_at
-- DESC). A marketplace/aggregator lead with no supplier-owned email is skipped
-- for cold outreach by design — the address reaches the platform, not the
-- supplier, so it is left for Agent 05 price-pull — but it stays at
-- stage='enriched' forever and therefore permanently occupies that window. New
-- marketplace leads land on top of it, so the block deepens on its own: measured
-- 375 actionable starved (2026-08-04) → 380 (08-05) → 663 (08-07), with
-- `marketplace_pricing=20` (the entire window) on ~90% of runs.
--
-- This is the same defect already fixed for phased holds, which the outreach
-- fetch excludes for exactly this reason. Marketplace leads are sticky the same
-- way and were never given the same treatment.
--
-- Deliberately a flag, not a stage change: Agent 05 / the price index select
-- these leads at stage='enriched', and moving them would break that data path.
-- Parking is invisible to every consumer except the outreach fetch.
alter table public.leads_in_flight
  add column if not exists outreach_parked_at timestamptz;

-- The outreach fetch is (stage, status, org_id, parked) ordered by created_at.
-- Partial on the un-parked set: that set is what the query reads, and it stays
-- small while the parked set grows without bound.
create index if not exists leads_in_flight_outreach_unparked_idx
  on public.leads_in_flight (org_id, created_at desc)
  where outreach_parked_at is null and stage = 'enriched' and status = 'active';

-- Un-park automatically the moment a lead gains (or changes) a contact email.
--
-- A trigger rather than an explicit un-park call in each writer: contact emails
-- are written from several places (Agent 06 enrichment, the contact-backfill
-- sweep, referred suppliers, marketplace→direct split) and a writer that forgot
-- to clear the flag would strand the lead permanently — recreating the exact
-- starvation bug this migration exists to fix. The trigger cannot be forgotten.
create or replace function public.clear_outreach_park_on_contact_change()
returns trigger
language plpgsql
as $$
begin
  if new.outreach_parked_at is not null
     and coalesce(new.payload->>'supplier_contact_email', '')
         is distinct from coalesce(old.payload->>'supplier_contact_email', '')
  then
    new.outreach_parked_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists leads_in_flight_clear_outreach_park on public.leads_in_flight;
create trigger leads_in_flight_clear_outreach_park
  before update on public.leads_in_flight
  for each row
  execute function public.clear_outreach_park_on_contact_change();

-- No backfill. Which leads are parkable is decided by the JS classifier
-- (marketplaceFor + the aggregator-host list in data-enrichment/enrich.ts, which
-- suffix-matches and cannot be faithfully restated in SQL). An approximate SQL
-- backfill could park an actionable lead, which is the one failure mode worse
-- than the bug. Agent 04 stamps them as it sees them and the window drains.
