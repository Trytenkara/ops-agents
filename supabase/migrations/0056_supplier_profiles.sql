-- Stores operator-curated supplier approval data, initially seeded from lead
-- enrichment, then editable in the Control Room. Maps to the Tenkara supplier
-- approval form so ops can get to ~80% completion before submitting.

create table if not exists supplier_profiles (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  supplier_id     text,                             -- Tenkara supplier ID; null for pre-platform suppliers
  supplier_name   text not null,

  -- Type
  supplier_type   text check (supplier_type in ('marketplace', 'direct')),

  -- Contact
  poc_email       text,
  poc_phone       text,
  poc_name        text,

  -- Shipping
  shipping_address    text,
  shipping_terms      text,
  shipping_email      text,
  ddp_can_book        boolean default false,
  ddp_min_limit       numeric(14,2),
  ddp_max_limit       numeric(14,2),

  -- Billing
  billing_email       text,
  billing_poc_name    text,

  -- Payment terms
  payment_upfront_pct numeric(5,2),
  payment_net_days    integer,
  payment_completion  text,
  payment_credit_line text,

  -- Accessorial charges
  hazmat_handling_fee     numeric(10,2) default 0,
  temp_storage_fee        numeric(10,2) default 0,
  liftgate_fee            numeric(10,2) default 0,
  special_packaging_fee   numeric(10,2) default 0,

  -- Checklist (operator verification flags)
  contact_info_complete       boolean default false,
  marketplace_type_correct    boolean default false,
  address_accurate            boolean default false,
  shipping_terms_correct      boolean default false,
  billing_verified            boolean default false,
  payment_info_verified       boolean default false,
  payment_terms_confirmed     boolean default false,

  -- Notes & status
  notes               text,
  approval_status     text not null default 'draft'
                      check (approval_status in ('draft', 'pending_review', 'ready_for_submission', 'submitted')),

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- A supplier_id can appear at most once per org (when linked to Tenkara).
create unique index if not exists supplier_profiles_org_supplier
  on supplier_profiles (org_id, supplier_id)
  where supplier_id is not null;

-- Fast lookup by org for the suppliers page.
create index if not exists supplier_profiles_org_id
  on supplier_profiles (org_id);

-- Updated-at trigger (reuse the existing function if available).
do $$
begin
  if not exists (
    select 1 from pg_proc where proname = 'set_updated_at'
  ) then
    create function set_updated_at() returns trigger as $fn$
    begin
      new.updated_at = now();
      return new;
    end;
    $fn$ language plpgsql;
  end if;
end
$$;

create trigger supplier_profiles_updated_at
  before update on supplier_profiles
  for each row execute function set_updated_at();
