-- Re-attempt contact finding for "parked" leads (rule 4: never give up).
--
-- A lead is promoted raw -> enriched the moment it has ANY reachable channel,
-- including a live website with NO email (enrich.ts: outreach_ready is true on
-- website_probe.ok alone). Those enriched-but-emailless leads are invisible to
-- claim_enrichment_leads (which is hard-filtered to stage='raw'), so Agent 06
-- never runs the contact waterfall over them again — they sit parked forever with
-- supplier_contact_email = null.
--
-- This function is the re-attempt hook. It flips a capped, cooled-down batch of
-- parked no-email leads back to stage='raw' so the EXISTING raw claim + full
-- contact stack (site scrape -> Tenkara -> Hunter -> LeadMagic -> ZoomInfo ->
-- GetProspect -> guessed-pattern combos) re-runs on them. Deliberately does NOT
-- touch the claim RPC or the run-enrich stage guards: a plain re-queue keeps the
-- hot path unchanged.
--
-- Ordering/stamp: it does NOT restamp last_enrichment_attempt_at, so a re-queued
-- lead keeps its old timestamp and sorts AFTER never-attempted leads (nulls first)
-- in the raw claim — parked re-tries can never starve fresh discovery. The cooldown
-- (default 7 days) keeps a genuinely-dead lead from cycling more than weekly, while
-- still honoring "re-attempt on the next pickup, don't give up".
create or replace function requeue_parked_contact_leads(
  p_org_ids uuid[],
  p_cap int,
  p_cooldown_hours int default 168
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  with picked as materialized (
    select c.id
      from leads_in_flight c
     where c.stage = 'enriched'
       and c.status = 'active'
       and c.org_id = any(p_org_ids)
       -- No usable direct email on the lead, by either payload location.
       and coalesce(c.payload->>'supplier_contact_email', '') = ''
       and coalesce(c.payload->'enrichment'->'contact'->>'email', '') = ''
       and (
         c.last_enrichment_attempt_at is null
         or c.last_enrichment_attempt_at < now() - make_interval(hours => p_cooldown_hours)
       )
     order by c.last_enrichment_attempt_at asc nulls first,
              c.created_at asc
     limit p_cap
       for update skip locked
  ), moved as (
    update leads_in_flight l
       set stage = 'raw'
      from picked p
     where l.id = p.id
    returning l.id
  )
  select count(*)::int into n from moved;
  return n;
end;
$$;

revoke all on function requeue_parked_contact_leads(uuid[], int, int) from public, anon, authenticated;
grant execute on function requeue_parked_contact_leads(uuid[], int, int) to service_role;
