-- Operator type + lanes, replacing the org-wide Primary/Backup pair.
--
-- Assignment used to answer "who owns this supplier" with one pool per org and a
-- single Primary/Backup pair as the fallback. That could not express the two
-- things ops actually needs: that a person does phone work OR email work on a
-- given client, and that a named group covers one market lane (a marketplace
-- squad who also complete marketplace info and validate quotes).
--
-- Both live on user_org_assignments rather than on users, because the grain is
-- per-client. That is also what enforces "can be both, but never for the same
-- client" for free: one row per (user, org) means one type per client, with no
-- rule to write or check.

alter table public.user_org_assignments
  add column if not exists operator_type text not null default 'email';

do $$
begin
  alter table public.user_org_assignments
    add constraint user_org_assignments_operator_type_check
    check (operator_type in ('call', 'email'));
exception
  when duplicate_object then null;
end $$;

-- Market lanes this person takes on this client. Defaulting to all three keeps
-- every existing operator's book exactly as it is: the pool filter is a no-op
-- until someone is deliberately narrowed to a lane.
alter table public.user_org_assignments
  add column if not exists lanes text[] not null
  default array['marketplace', 'aggregator', 'direct'];

do $$
begin
  alter table public.user_org_assignments
    add constraint user_org_assignments_lanes_check
    check (lanes <@ array['marketplace', 'aggregator', 'direct']);
exception
  when duplicate_object then null;
end $$;

comment on column public.user_org_assignments.operator_type is
  'Whether this person does call or email work for this client. One row per (user, org), so a person can be a call operator on one client and an email operator on another, but never both on the same one.';
comment on column public.user_org_assignments.lanes is
  'Market lanes this person is assigned within this client. The auto spread only draws from operators whose lanes include the supplier''s kind; it falls back to the whole pool when no operator covers a lane, so nothing goes unowned.';
