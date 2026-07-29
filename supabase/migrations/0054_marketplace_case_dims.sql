-- Migration 0054 - marketplace case-dimension cache
--
-- Marketplace pricing rows (leads_in_flight.payload.price_tiers[] and
-- marketplace_check_findings) carry a free-text pack_size ("25 kg", "1 drum",
-- "250 g"), which is exactly the input the case-dimension SOP wants. Rather than
-- recompute dims for every row (the same pack size recurs across hundreds of
-- leads), we cache one estimate per NORMALIZED pack size and resolve it at render
-- time on the Leads and Live Price Index views.
--
-- These are pack-size-keyed estimates (material-agnostic), so dim_source is
-- always 'ai_estimated'. case_dimensions mirrors the Tenkara shape:
--   {"unit":"in","width":W,"height":H,"length":L,"packaging_case_weight":KG}

create table if not exists public.marketplace_case_dims (
  pack_size_norm  text primary key,
  case_type       text,
  case_dimensions jsonb,
  dim_source      text not null default 'ai_estimated',
  sample_raw      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
