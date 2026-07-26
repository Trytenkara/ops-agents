-- Agent 06's raw-lead sweep ordered by confidence_score alone -- a key a failed
-- enrichment never changes. Once 25 blocked leads collected at the top of a score
-- tier, every run re-selected the same rows and promotion locked at exactly zero
-- (sealed 2026-07-26 14:20 UTC, 7,005 eligible leads stranded behind it).
-- Ordering by attempt time makes the key self-mutating: an attempt pushes its lead
-- to the back, so untried work always sorts ahead and a blocked lead only returns
-- once the queue has cycled. That also gives retry-after for free.
alter table public.leads_in_flight
  add column if not exists last_enrichment_attempt_at timestamptz;

-- Seed from the timestamp the enricher already writes, so deploying the fix does
-- not re-probe every lead that has been tried before. Guarded on null to stay
-- idempotent: db-push replays every migration on each run, and an unguarded
-- update would rewind live attempt times back to the payload value every time.
update public.leads_in_flight
set last_enrichment_attempt_at = (payload->'enrichment'->>'enriched_at')::timestamptz
where last_enrichment_attempt_at is null
  and payload->'enrichment'->>'enriched_at' is not null;

-- Mirrors the sweep's ORDER BY so the planner walks the index instead of top-N
-- sorting the whole raw pool.
create index if not exists leads_in_flight_enrichment_sweep_idx
  on public.leads_in_flight (last_enrichment_attempt_at asc nulls first, confidence_score desc nulls last)
  where stage = 'raw' and status = 'active';
