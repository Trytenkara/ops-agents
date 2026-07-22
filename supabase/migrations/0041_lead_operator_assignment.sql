-- Manual operator assignment at the lead grain. Supplier-backed leads sync
-- ownership through supplier_assignment (keyed by supplier_id); Scout/AI-discovery
-- leads have no supplier_id, so they had no way to be reassigned and fell to the
-- sticky-random default. This column lets ops claim a specific discovery lead
-- (agents route its outreach to the named operator). NULL = fall back to auto.
-- Idempotent.

alter table public.leads_in_flight
  add column if not exists assigned_operator_id uuid references public.users(id) on delete set null;

create index if not exists leads_in_flight_assigned_operator_idx
  on public.leads_in_flight(assigned_operator_id);
