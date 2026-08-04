-- Density is a physical property of the MATERIAL, but we only ever stored it on
-- quote_profiles. A lead priced in litres therefore had no density to convert
-- with, and most materials that need one (McGinley, Nutripro, Vita Organica,
-- and the marketplace leads generally) have no quote_profiles row at all, so
-- there was nowhere to write the answer even after looking it up.
--
-- This table is that place. Keyed by normalized material name, deliberately not
-- by org: a density has a public citation and is true for every client quoting
-- the same material. Ranked source, because a supplier SDS and a blog post are
-- not equally good, and a worse source must never displace a better one.
create table if not exists public.material_densities (
  material_key  text primary key,
  material_name text not null,
  -- Nullable on purpose: a row with density null and a reason in notes records
  -- "we looked and the number is not published", which stops the lookup being
  -- paid for again every run. The readers treat it as no density, same as absent.
  density       numeric check (density is null or (density > 0 and density < 25)),
  unit          text not null default 'g/ml',
  -- Which density this is. For a volumetric pack we need the number that says
  -- how much product fits in the container: specific gravity for a liquid, BULK
  -- density for a powder. A crystal ("true") density is the wrong number and is
  -- rejected rather than stored, because it can overstate a pail by 4x.
  kind          text check (kind in ('liquid', 'bulk')),
  source        text,
  source_rank   text not null default 'unattributed'
    check (source_rank in ('operator', 'listing', 'document', 'web', 'unattributed')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column public.material_densities.material_key is
  'Normalized name (lib/material-density.ts materialKey). Exact match only: "sodium hydroxide" and "sodium hydroxide solution" differ by 50%.';
comment on column public.material_densities.source_rank is
  'Precedence, best first: operator > listing > document (SDS/TDS) > web > unattributed.';
