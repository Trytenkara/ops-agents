-- One profile per supplier, enforced.
--
-- seedProfilesFromLeads deduped against a read that PostgREST truncated at 1000
-- rows, so every supplier past the cap was re-inserted on each Agent 06 run
-- (~57k rows/day since 2026-07-31). The read is now paginated; this collapses
-- the rows it already created and makes the failure mode impossible rather than
-- merely unlikely.
--
-- Survivor per (org_id, supplier_id or lowercased name): the richest row, so no
-- operator entry or enrichment is lost to the cleanup.
with ranked as (
  select id,
    row_number() over (
      partition by org_id, coalesce(supplier_id, lower(trim(supplier_name)))
      order by (notes is not null and notes <> '') desc,
               (approval_status is distinct from 'draft') desc,
               (poc_email is not null) desc,
               (poc_phone is not null) desc,
               (shipping_address is not null) desc,
               updated_at desc, created_at asc, id
    ) as rn
  from public.supplier_profiles
)
delete from public.supplier_profiles p
using ranked r
where p.id = r.id and r.rn > 1;

create unique index if not exists supplier_profiles_org_supplier_id_uniq
  on public.supplier_profiles (org_id, supplier_id)
  where supplier_id is not null;

create unique index if not exists supplier_profiles_org_supplier_name_uniq
  on public.supplier_profiles (org_id, lower(trim(supplier_name)))
  where supplier_id is null;
