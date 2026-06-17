-- Migration 0029 - Client material orders (Material Profile tab).
--
-- Ops upload PO documents which are LLM-parsed into structured order lines.
-- One row per parsed order line. Used to compute per-material usage frequency
-- and recommend minimum acceptable shelf-life (material + COA expiry).
--
-- Standing invariants: writes land in OA only; Tenkara prod stays read-only.
-- Materials themselves come from Tenkara read-only; tenkara_material_id links
-- a parsed line back to that material once matched (null until then).
-- Service-role writes (server actions) bypass RLS; reads are org-scoped like
-- the other org tables (see 0016 / 0021).

create table if not exists public.client_material_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  tenkara_material_id text,            -- null until matched to a Tenkara material
  material_label text not null,        -- as parsed / displayed
  supplier_name text,
  order_date date,
  ordered_qty numeric,                 -- actual quantity ordered
  qty_unit text,
  po_qty numeric,                      -- quantity stated on the PO (vs ordered_qty)
  unit_price numeric,
  coa_expiry date,
  material_expiry date,
  source_upload_id uuid references public.client_uploads(id) on delete set null,
  parsed_raw jsonb,                    -- raw LLM extraction, kept for audit
  status text not null default 'parsed' check (status in ('parsed','confirmed')),
  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);

create index if not exists client_material_orders_org_material_idx
  on public.client_material_orders (org_id, tenkara_material_id);

-- ------------------------------------------------------------
-- RLS: same org-scoped read gating as client_settings (0021).
-- user_has_org_access() / has_any_role() defined in 0016.
-- ------------------------------------------------------------
alter table public.client_material_orders enable row level security;

drop policy if exists client_material_orders_read on public.client_material_orders;
create policy client_material_orders_read on public.client_material_orders for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );
