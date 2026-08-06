-- (Renumbered from a duplicate 0093; already applied in prod, and the body is a
-- create-or-replace, so re-running it in this position is a no-op.)
-- Reserve part of every enrichment claim for leads that have been tried before.
--
-- 0083/0086 ordered the claim `last_enrichment_attempt_at asc nulls first`, i.e.
-- never-attempted work strictly ahead of any retry. That is only fair while the
-- untried group empties. It does not: discovery adds ~1,994 never-attempted raw
-- leads a day against ~1,689/day of enrichment throughput, so the untried group
-- never drains and the retry tail behind it is claimed approximately never.
--
-- Measured on 2026-08-05 for the three sourcing orgs: 3,133 raw leads never
-- attempted, 1,732 previously attempted. Every lead that
-- requeue_parked_contact_leads flips back to 'raw' lands in that second group
-- (the re-queue deliberately does not clear the attempt stamp), so the
-- parked-contact re-try shipped in 0088/0092 was structurally correct and
-- functionally starved: the rows moved to 'raw' and then sat there.
--
-- So the cap is split rather than ordered. A fifth of each run is held for the
-- oldest-attempted leads, the rest goes to untried work, and either group takes
-- the whole cap when the other is short (a quiet discovery day still fills the
-- run with retries, and a fleet with no retries pending is unaffected). Locking
-- and stamp semantics are unchanged from 0086: both picks are FOR UPDATE SKIP
-- LOCKED so concurrent lanes cannot be handed the same lead.
create or replace function claim_enrichment_leads(p_org_ids uuid[], p_cap int)
returns table (
  id uuid,
  org_id uuid,
  supplier_id text,
  supplier_name text,
  material_name text,
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
declare
  -- 5 of 25. Enough to outpace REQUEUE_PARKED_PER_RUN across the two lanes
  -- without taking a meaningful bite out of first-attempt throughput.
  v_slice int := greatest(1, p_cap / 5);
  v_ids uuid[];
begin
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select c.id
        from leads_in_flight c
       where c.stage = 'raw'
         and c.status = 'active'
         and c.org_id = any(p_org_ids)
         and c.last_enrichment_attempt_at is not null
       order by c.last_enrichment_attempt_at asc,
                c.confidence_score desc nulls last,
                c.created_at asc
       limit v_slice
         for update skip locked
    ) s;

  select v_ids || coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select c.id
        from leads_in_flight c
       where c.stage = 'raw'
         and c.status = 'active'
         and c.org_id = any(p_org_ids)
         and c.last_enrichment_attempt_at is null
       order by c.confidence_score desc nulls last,
                c.created_at asc
       limit p_cap - coalesce(array_length(v_ids, 1), 0)
         for update skip locked
    ) s;

  -- Not enough untried work to fill the run, so spend the remainder on the retry
  -- tail. `not (id = any(v_ids))` is a no-op against an empty array.
  if coalesce(array_length(v_ids, 1), 0) < p_cap then
    select v_ids || coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
      from (
        select c.id
          from leads_in_flight c
         where c.stage = 'raw'
           and c.status = 'active'
           and c.org_id = any(p_org_ids)
           and c.last_enrichment_attempt_at is not null
           and not (c.id = any(v_ids))
         order by c.last_enrichment_attempt_at asc,
                  c.confidence_score desc nulls last,
                  c.created_at asc
         limit p_cap - coalesce(array_length(v_ids, 1), 0)
           for update skip locked
      ) s;
  end if;

  return query
  with picked as materialized (
    select c.id, c.last_enrichment_attempt_at as prev_attempt_at
      from leads_in_flight c
     where c.id = any(v_ids)
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
