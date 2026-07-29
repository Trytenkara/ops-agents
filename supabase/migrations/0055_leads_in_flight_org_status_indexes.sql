-- leads_in_flight only had indexes on id (pkey), assigned_operator_id, and the
-- partial raw/active enrichment sweep. Every org-scoped read (per-client views,
-- the Control Room rollups) and every status-scoped scan therefore seq-scanned
-- the whole table. On the ~2-vCPU instance those scans pinned CPU in bursts and
-- starved GoTrue, so logged-in users intermittently saw
-- "Authentication service temporarily unavailable" (middleware 5s auth timeout).
--
-- Plain create index (not CONCURRENTLY): supabase db push runs each migration in
-- a transaction, where CONCURRENTLY is illegal, and at ~21k rows the build locks
-- the table for only tens of milliseconds.

-- Org-scoped reads filter on org_id and usually order by / bound on created_at.
create index if not exists leads_in_flight_org_created_idx
  on public.leads_in_flight (org_id, created_at desc);

-- The recurring "active raw pool" scans filter on status (and often stage) without
-- matching the partial enrichment-sweep index's ordering.
create index if not exists leads_in_flight_status_stage_idx
  on public.leads_in_flight (status, stage);
