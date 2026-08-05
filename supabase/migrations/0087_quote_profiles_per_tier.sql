-- Migration 0087 - one quote profile per marketplace pack tier
--
-- A marketplace listing's price ladder is N quotes, not one. quote_profiles was
-- keyed one-per-supplier×material (0066), so the seeder could only ever keep the
-- headline price and silently dropped the rest of the ladder (13 of Bulk
-- Apothecary's 14 tiers, 3 of HBNO's 4). pack_size carries the tier label and
-- joins the uniqueness key so every tier gets its own validatable quote.

alter table public.quote_profiles add column if not exists pack_size text;

drop index if exists public.quote_profiles_org_supplier_material_ids_idx;
drop index if exists public.quote_profiles_org_supplier_material_names_idx;

-- coalesce, not a bare column: NULLs compare as distinct in a unique index, so a
-- null pack_size would let unlimited duplicates through the guard.
create unique index if not exists quote_profiles_org_supplier_material_pack_ids_idx
  on public.quote_profiles (org_id, supplier_id, material_id, coalesce(lower(trim(pack_size)), ''))
  where supplier_id is not null and material_id is not null;

create unique index if not exists quote_profiles_org_supplier_material_pack_names_idx
  on public.quote_profiles (org_id, lower(trim(supplier_name)), lower(trim(material_name)), coalesce(lower(trim(pack_size)), ''))
  where supplier_id is null or material_id is null;
