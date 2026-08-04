-- Named locks for things the single agents.locked_until reservation cannot cover.
--
-- The immediate need: parallel lanes. Lane 1 holds agents.locked_until, but
-- lanes 2..N deliberately skip it, so on its own nothing stops them stacking.
-- The dispatcher awaits every agent it triggers and can run for the full 800s
-- while the pg_cron pinger keeps firing, so overlapping ticks are normal, not an
-- edge case: without a per-lane lock a second tick's lane 1 correctly bounces
-- off the agent lock while its lanes 2 and 3 sail past, silently doubling
-- contact-API spend.
create table if not exists runtime_locks (
  key text primary key,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Acquire-or-fail in ONE statement. Returns true only if this caller now holds
-- the lock. The conflict branch is guarded on expiry, so a lock whose holder was
-- hard-killed (no release ever ran) self-heals once the TTL passes, while a live
-- holder is never stolen from.
create or replace function try_runtime_lock(p_key text, p_ttl_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_got boolean;
begin
  insert into runtime_locks (key, locked_until, updated_at)
  values (p_key, now() + make_interval(secs => p_ttl_seconds), now())
  on conflict (key) do update
     set locked_until = excluded.locked_until,
         updated_at = now()
   where runtime_locks.locked_until < now()
  returning true into v_got;

  return coalesce(v_got, false);
end;
$$;

create or replace function release_runtime_lock(p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  update runtime_locks set locked_until = now() - interval '1 second', updated_at = now() where key = p_key;
$$;

alter table runtime_locks enable row level security;
revoke all on function try_runtime_lock(text, int) from public, anon, authenticated;
revoke all on function release_runtime_lock(text) from public, anon, authenticated;
grant execute on function try_runtime_lock(text, int) to service_role;
grant execute on function release_runtime_lock(text) to service_role;
