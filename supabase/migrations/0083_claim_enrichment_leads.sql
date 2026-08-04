-- Agent 06 runs in parallel lanes. Each lane must take a DISJOINT set of raw
-- leads, so the pick and the mark have to be one atomic step: a plain
-- SELECT-then-UPDATE lets two lanes read the same 25 rows and enrich each of
-- them twice (double contact-API spend, double outbound risk).
--
-- FOR UPDATE SKIP LOCKED does the picking, but the row locks die with this
-- function's transaction, so they alone cannot keep a lane that calls one
-- millisecond later off the same rows. The load-bearing part is the STAMP:
-- setting last_enrichment_attempt_at pushes the claimed batch to the back of the
-- pull's own ordering (attempt time ascending, nulls first), so the next lane's
-- claim necessarily lands on different work.
--
-- prev_attempt_at is returned because that stamp is a promise the caller may not
-- keep: leads it drops for its wall-clock deadline were never actually attempted,
-- and if the stamp stood they would fall behind a 4,000-deep queue for days
-- despite never having been touched. The caller restores this value for anything
-- it skipped.
drop function if exists claim_enrichment_leads(uuid[], int);
create or replace function claim_enrichment_leads(p_org_ids uuid[], p_cap int)
returns table (
  id uuid,
  org_id uuid,
  supplier_id text,
  supplier_name text,
  material_name text,
  source text,
  payload jsonb,
  confidence_score numeric,
  prev_attempt_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  -- MATERIALIZED is not cosmetic: this CTE is referenced twice, and an inlined
  -- copy would run the locking SELECT a second time against rows the UPDATE has
  -- already moved.
  with picked as materialized (
    select c.id, c.last_enrichment_attempt_at as prev_attempt_at
      from leads_in_flight c
     where c.stage = 'raw'
       and c.status = 'active'
       and c.org_id = any(p_org_ids)
     order by c.last_enrichment_attempt_at asc nulls first,
              c.confidence_score desc nulls last,
              -- Age is the final tiebreaker. Without it, ties among equal scores
              -- resolved arbitrarily and 11-day-old leads kept losing to
              -- newly-arrived ones of the same score.
              c.created_at asc
     limit p_cap
       for update skip locked
  ), claimed as (
    update leads_in_flight l
       set last_enrichment_attempt_at = now()
      from picked p
     where l.id = p.id
    returning l.id, l.org_id, l.supplier_id, l.supplier_name, l.material_name,
              l.source, l.payload, l.confidence_score
  )
  select c.id, c.org_id, c.supplier_id, c.supplier_name, c.material_name,
         c.source, c.payload, c.confidence_score, p.prev_attempt_at
    from claimed c
    join picked p on p.id = c.id;
end;
$$;

revoke all on function claim_enrichment_leads(uuid[], int) from public, anon, authenticated;
grant execute on function claim_enrichment_leads(uuid[], int) to service_role;
