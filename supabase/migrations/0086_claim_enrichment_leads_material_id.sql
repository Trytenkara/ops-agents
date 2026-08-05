-- Carry material_id out of the enrichment claim.
--
-- The column has been on leads_in_flight since 0001 and every discovery writer
-- sets it, but the claim dropped it, so the whole enrichment pass identified a
-- lead's material by NAME only. That is enough for the token-overlap relevance
-- check and nothing else: a client's dealbreaker specs live in Tenkara keyed by
-- materials.id, so without the uuid there is no way to ask "what grade must this
-- supplier actually be able to supply?" while the lead is still being enriched.
--
-- Purely additive: same ordering, same locking, same stamp semantics as 0083.
-- The return type changes, hence the drop.
drop function if exists claim_enrichment_leads(uuid[], int);
create or replace function claim_enrichment_leads(p_org_ids uuid[], p_cap int)
returns table (
  id uuid,
  org_id uuid,
  supplier_id text,
  supplier_name text,
  material_name text,
  -- text, not uuid: leads_in_flight stores Tenkara ids as text (same as
  -- supplier_id). Declaring uuid here fails the function's result-type check.
  material_id text,
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
              l.material_id, l.source, l.payload, l.confidence_score
  )
  select c.id, c.org_id, c.supplier_id, c.supplier_name, c.material_name,
         c.material_id, c.source, c.payload, c.confidence_score, p.prev_attempt_at
    from claimed c
    join picked p on p.id = c.id;
end;
$$;

revoke all on function claim_enrichment_leads(uuid[], int) from public, anon, authenticated;
grant execute on function claim_enrichment_leads(uuid[], int) to service_role;
