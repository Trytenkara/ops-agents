-- Operator decisions about suspected duplicate suppliers.
--
-- The suggestions themselves are NOT stored. They are recomputed on every page
-- load from the read-only Tenkara supplier list, so a group can never go stale
-- against a supplier that was renamed or removed in Tenkara. Only the human
-- judgement is durable, and that is what this table holds.
--
-- Tenkara writes are prohibited. Confirming a merge here records an intent for
-- an operator to carry out in Tenkara; nothing in this repo edits a supplier.
--
-- Grain is the PAIR, not the group. A group's membership changes every time
-- scout promotes another name variant on the same domain, so a group-level key
-- would be invalidated by the next arrival and the same rejected pair would be
-- re-suggested forever. Pairs are stable: "these two are not the same company"
-- stays true no matter who else lands on the domain later.

create table if not exists public.supplier_dupe_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete cascade,

  -- Tenkara supplier ids, stored lo/hi so a pair has exactly one row
  -- regardless of which order the UI happened to present them in.
  supplier_id_lo uuid not null,
  supplier_id_hi uuid not null,

  -- Names as they read at decision time. Tenkara may rename or delete the row
  -- later; without this the audit trail becomes a pair of bare uuids.
  supplier_name_lo text,
  supplier_name_hi text,

  decision text not null check (decision in ('not_duplicate', 'same_company')),

  -- Which row the operator intends to keep. Only meaningful for 'same_company',
  -- and only a plan: the merge happens by hand in Tenkara.
  survivor_supplier_id uuid,

  -- Set once the operator confirms they carried the merge out in Tenkara.
  resolved_at timestamptz,

  note text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint supplier_dupe_decisions_pair_ordered check (supplier_id_lo < supplier_id_hi),
  constraint supplier_dupe_decisions_survivor_is_member check (
    survivor_supplier_id is null
    or survivor_supplier_id = supplier_id_lo
    or survivor_supplier_id = supplier_id_hi
  ),
  -- A survivor only means something for a pair we agreed is one company.
  constraint supplier_dupe_decisions_survivor_needs_same_company check (
    decision = 'same_company' or survivor_supplier_id is null
  )
);

-- One decision per pair per org. Re-deciding updates in place (upsert target).
create unique index if not exists supplier_dupe_decisions_pair_uidx
  on public.supplier_dupe_decisions (org_id, supplier_id_lo, supplier_id_hi);

-- The page loads every decision for one org at a time.
create index if not exists supplier_dupe_decisions_org_idx
  on public.supplier_dupe_decisions (org_id, decision);

alter table public.supplier_dupe_decisions enable row level security;

-- Reads and writes go through the service-role admin client behind the app's
-- own role checks, matching every other operator surface in this repo.
drop policy if exists supplier_dupe_decisions_service_all on public.supplier_dupe_decisions;
create policy supplier_dupe_decisions_service_all
  on public.supplier_dupe_decisions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
