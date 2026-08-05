-- Fix the "parked no-email lead" predicate: a placeholder is not a contact.
--
-- 0088 defined "no usable email" as the field being EMPTY. But enrichment and the
-- scout both write prose into supplier_contact_email when a supplier only exposes
-- a form: "via website contact form", "via IndiaMART inquiry", "contact form on
-- website". Those are non-empty, so 0088 read them as a contact on file and never
-- re-queued the lead, while Agent 04 read the same value as unusable (it requires
-- enrichment.email_check.format_valid, i.e. a syntactically valid address) and
-- parked or dropped it. The lead was therefore contacted-enough to skip enrichment
-- and uncontactable-enough to skip outreach: a permanent dead end. Measured
-- 2026-08-05: 1,739 enriched+active leads sat in it, 293 of them on paying clients.
--
-- So "usable" now means the same thing to both agents: a syntactically valid
-- address in either payload location. format_valid agreed with this regex on all
-- 6,636 leads that carry one, so the two gates line up exactly rather than
-- approximately.
--
-- Also orders real clients ahead of internal test orgs. p_cap is a shared cap over
-- a queue serving both, and internal orgs held 1,268 of the 1,739, so a plain FIFO
-- would spend the fleet's contact budget on test data before reaching a client.
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
      join orgs o on o.id = c.org_id
     where c.stage = 'enriched'
       and c.status = 'active'
       and c.org_id = any(p_org_ids)
       -- No syntactically valid address in either payload location. A non-address
       -- ("via website contact form") counts as no contact, matching Agent 04.
       and coalesce(c.payload->>'supplier_contact_email', '') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'
       and coalesce(c.payload->'enrichment'->'contact'->>'email', '') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'
       and (
         c.last_enrichment_attempt_at is null
         or c.last_enrichment_attempt_at < now() - make_interval(hours => p_cooldown_hours)
       )
     order by coalesce(o.is_internal, false) asc,
              c.last_enrichment_attempt_at asc nulls first,
              c.created_at asc
     limit p_cap
       -- OF c: locking the orgs row too would make a contact re-queue block org
       -- edits (pausing a client) for no reason.
       for update of c skip locked
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
