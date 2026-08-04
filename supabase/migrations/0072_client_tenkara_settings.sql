-- Tenkara-synced client settings.
--
-- Tenkara is the source of truth for a client's ship-to, billing/samples
-- addresses and sourcing rules (ops edit them in Tenkara's Client Settings,
-- stored in public.user_supplier_settings). Nothing in OA ever read them, so a
-- change made in Tenkara could never reach an agent: suppliers asking "where
-- does this ship?" got a deferral because the only channel was a hand-typed
-- client_settings.sourcing_notes box.
--
-- This table is a mirror, NOT an ops-editable surface. Every column is
-- overwritten wholesale on each sync and nothing here respects
-- manual_override — that is the point, so a Tenkara edit can never fail to
-- pull through. Ops-authored settings stay in client_settings.

create table if not exists public.client_tenkara_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,

  -- Default ship-to, flattened from shipping_addresses[0] for cheap reads.
  ship_to_company       text,
  ship_to_address_line  text,
  ship_to_apartment     text,
  ship_to_city          text,
  ship_to_state         text,
  ship_to_zip           text,
  ship_to_country       text,

  -- Every configured ship-to, verbatim, so a multi-site client isn't
  -- silently truncated to one address.
  shipping_addresses jsonb not null default '[]'::jsonb,
  billing_address    jsonb,
  samples_address    jsonb,

  unit_of_measurement text,
  federal_tax_id      text,
  excluded_material_countries  text[] not null default '{}',
  excluded_packaging_countries text[] not null default '{}',
  pre_order_requirements  jsonb,
  post_order_requirements jsonb,

  -- source_updated_at is Tenkara's own updated_at, so ops can see how fresh
  -- the upstream record is, distinct from when we last pulled it.
  source_updated_at timestamptz,
  synced_at  timestamptz not null default now(),
  sync_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.client_tenkara_settings enable row level security;

comment on table public.client_tenkara_settings is
  'Read-only mirror of Tenkara user_supplier_settings, refreshed hourly by Agent 12. Never edit by hand: the sync overwrites everything.';
