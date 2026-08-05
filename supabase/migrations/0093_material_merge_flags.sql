-- Duplicate-material merge flags. A client can hold two material records for one
-- substance ("Butylene Glycol" and "Butylene Glycol 1,3"). Each is scouted
-- independently, so the same supplier is discovered twice and would be emailed
-- twice about one chemical. Material names live in Tenkara (read-only), so the
-- consolidation is expressed OA-side: Agent 03 flags the pair, an operator
-- reviews it, and applying folds the duplicate's leads into the survivor.
--
-- Only pairs whose grades do NOT conflict are ever flagged: equal grade sets, or
-- one side naming no grade at all (unspecified, not a competing spec). Two
-- records with genuinely different grades are deliberate separate line items (a
-- client sourcing Whey Protein Isolate AND Concentrate 80%) and must never merge.
create table if not exists public.material_merge_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  -- Survivor: keeps its name and absorbs the duplicate's leads. Always the
  -- graded side, so a merge can never drop a spec the client asked for.
  keep_material_id text not null,
  keep_name text not null,
  keep_grades text,

  -- The duplicate being folded in.
  drop_material_id text not null,
  drop_name text not null,
  drop_grades text,

  reason text not null check (reason in ('identical_name', 'locant_variant')),

  -- Sized at flag time so the operator can see the cost of leaving it split.
  drop_lead_count int,
  shared_supplier_count int,

  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  slack_ts text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id)
);

-- One flag per unordered pair, so a re-scan can't duplicate it and a flipped
-- survivor choice can't open a second row for the same two materials.
create unique index if not exists material_merge_flags_pair_idx
  on public.material_merge_flags (
    org_id,
    least(keep_material_id, drop_material_id),
    greatest(keep_material_id, drop_material_id)
  );

create index if not exists material_merge_flags_pending_idx
  on public.material_merge_flags (org_id) where status = 'pending';
