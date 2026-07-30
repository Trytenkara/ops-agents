-- Migration 0057 - quote_profiles
--
-- Quote approval tracking table, parallel to supplier_profiles (0056).
-- Captures all fields from the Tenkara "Add New Quote" form so ops can
-- fill them to 80%+ completeness in the Control Room before submitting
-- to Tenkara for approval. No write-back to Tenkara; ops exports CSV.

create table if not exists public.quote_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,

  -- Link to supplier (Tenkara or our supplier_profiles)
  supplier_id text,
  supplier_name text not null,

  -- Material
  material_id text,
  material_name text not null,

  -- Quoting
  price numeric(14,4),
  case_size numeric(14,4),
  unit_of_measurement text,
  currency text default 'USD',
  case_type text,
  case_width numeric(10,2),
  case_height numeric(10,2),
  case_length numeric(10,2),
  case_dimensions_unit text default 'in',
  case_weight numeric(10,2),
  quote_expiry date,

  -- Lead time & inventory
  lead_time_days integer,
  min_inventory numeric(14,4),
  min_inventory_unit text,
  max_inventory numeric(14,4),
  max_inventory_unit text,

  -- Flags
  is_hazardous boolean default false,
  is_refrigerated boolean default false,
  protect_from_freezing boolean default false,

  -- Equipment accessorials (from supplier profile, but per-quote overrides)
  material_sku text,

  -- Purchasing
  purchasing_notes text,

  -- Qualifying quick checks
  name_match boolean default false,
  inci_match boolean default false,
  grades_match boolean default false,
  grades_match_detail text,
  additional_grades text,

  -- Pre-order requirements
  preorder_coa_required boolean default false,
  preorder_coa_dealbreaker boolean default false,
  preorder_coa_requested boolean default false,
  preorder_coa_met boolean default false,
  preorder_sds_required boolean default false,
  preorder_sds_dealbreaker boolean default false,
  preorder_sds_requested boolean default false,
  preorder_sds_met boolean default false,
  preorder_tds_required boolean default false,
  preorder_tds_dealbreaker boolean default false,
  preorder_tds_requested boolean default false,
  preorder_tds_met boolean default false,
  preorder_sample_required boolean default false,
  preorder_sample_dealbreaker boolean default false,
  preorder_sample_requested boolean default false,
  preorder_sample_met boolean default false,

  -- Post-order requirements
  postorder_coa_required boolean default false,
  postorder_coa_dealbreaker boolean default false,
  postorder_sds_required boolean default false,
  postorder_sds_dealbreaker boolean default false,
  postorder_tds_required boolean default false,
  postorder_tds_dealbreaker boolean default false,

  -- Notes
  notes text,

  -- Approval workflow
  approval_status text not null default 'draft'
    check (approval_status in ('draft','pending_review','ready_for_submission','submitted')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quote_profiles_org_idx
  on public.quote_profiles (org_id);
create index if not exists quote_profiles_supplier_idx
  on public.quote_profiles (supplier_id);
create index if not exists quote_profiles_material_idx
  on public.quote_profiles (material_id);

do $$
begin
  drop trigger if exists trg_touch_quote_profiles on public.quote_profiles;
  create trigger trg_touch_quote_profiles before update on public.quote_profiles
    for each row execute function public.touch_updated_at();
end$$;

alter table public.quote_profiles enable row level security;

drop policy if exists quote_profiles_read on public.quote_profiles;
create policy quote_profiles_read on public.quote_profiles for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );

drop policy if exists quote_profiles_write on public.quote_profiles;
create policy quote_profiles_write on public.quote_profiles for all to authenticated
  using (
    public.has_any_role(array['admin','ops_lead'])
    or (public.has_any_role(array['ops_operator']) and public.user_has_org_access(org_id))
  )
  with check (
    public.has_any_role(array['admin','ops_lead'])
    or (public.has_any_role(array['ops_operator']) and public.user_has_org_access(org_id))
  );
