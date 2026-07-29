-- The orphan reaper runs on every agent run and matched no index, so it
-- sequentially scanned all of agent_runs (9 MB, ~47k rows) to return zero rows.
--
-- The reaper predicate is `status = $1 AND run_started_at < $2 AND
-- run_finished_at IS NULL`. Only the IS NULL is a literal, so it is the only
-- part the planner can prove against a partial index predicate; status arrives
-- as a bind parameter and is unprovable under a generic plan. Keeping status in
-- the index columns rather than the predicate makes the index usable either way.
create index if not exists agent_runs_reaper_idx
  on public.agent_runs (status, run_started_at)
  where run_finished_at is null;

-- payload averages ~2 KB and is read in full by the platform's sourcing sync,
-- so TOAST decompression dominates that read. lz4 decompresses several times
-- faster than pglz for identical output. Applies to new writes only; existing
-- values stay pglz until rewritten.
alter table public.leads_in_flight alter column payload set compression lz4;

-- pg_cron never prunes its own history. Left alone it grew to ~27k rows, at
-- which point scanning it took 20 s under load.
select cron.schedule(
  'prune_cron_history_daily',
  '37 3 * * *',
  $$delete from cron.job_run_details where start_time < now() - interval '7 days'$$
);
