-- Per-org controls over automatic supplier→operator assignment. Ops asked for
-- three levers after adding an operator to an org silently re-derived who owned
-- which supplier:
--   1. assignment_mode        — manual (claims only) / auto_new (auto fills the
--                               gaps, claims win) / auto_all (auto owns
--                               everything, claims ignored).
--   2. assignment_supplier_types — which market kinds the auto loop covers, so a
--                               team can auto-spread marketplaces while keeping
--                               direct suppliers hand-picked.
--   3. user_org_assignments.auto_assignable — take one person out of the auto
--                               loop without removing them from the org (lead
--                               operators, or a role that was misassigned).
-- Idempotent.

-- Added nullable, backfilled, THEN defaulted: orgs that already exist keep
-- today's behavior (auto_new) while orgs created from here on default to manual,
-- which is what ops asked for. Doing it in this order also makes the backfill a
-- no-op on re-run, so a later manual switch to 'manual' is not reverted by the
-- next db-push.
alter table public.orgs add column if not exists assignment_mode text;
update public.orgs set assignment_mode = 'auto_new' where assignment_mode is null;
alter table public.orgs alter column assignment_mode set default 'manual';
alter table public.orgs alter column assignment_mode set not null;

alter table public.orgs drop constraint if exists orgs_assignment_mode_check;
alter table public.orgs add constraint orgs_assignment_mode_check check (
  assignment_mode in (
    'manual',    -- only explicit supplier_assignment claims own anything
    'auto_new',  -- claim wins, auto fills every unclaimed supplier
    'auto_all'   -- auto owns every supplier in scope; claims are ignored, not deleted
  )
);

-- Market kinds the auto loop is allowed to assign (values from lib/lead-market
-- MarketKind). A supplier whose kind is not listed keeps its claim and gets no
-- derived owner. A supplier with no known kind counts as 'direct', matching how
-- supplier_profiles.supplier_type is seeded. Empty array = auto assigns nothing.
alter table public.orgs
  add column if not exists assignment_supplier_types text[] not null
  default array['marketplace', 'aggregator', 'direct']::text[];

-- Membership stays; only auto-loop eligibility changes. Still manually
-- assignable, so ops can hand this person a specific supplier.
alter table public.user_org_assignments
  add column if not exists auto_assignable boolean not null default true;
