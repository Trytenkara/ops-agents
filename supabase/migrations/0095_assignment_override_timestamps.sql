-- "Auto, reassign all" ignores manual claims at read time, which is what makes it
-- a reassignment rather than a fill-the-gaps. But it also meant an ops lead could
-- not correct a single supplier afterwards: the override was written, then
-- silently lost on the next render.
--
-- Record when the org chose auto_all, and stamp when a claim was made. A claim
-- made AFTER that choice is a deliberate correction and outranks the spread;
-- claims older than it are exactly what auto_all was asked to reassign. Nothing
-- is deleted either way, so switching back to auto_new restores them all.
alter table public.orgs
  add column if not exists assignment_auto_all_at timestamptz;

comment on column public.orgs.assignment_auto_all_at is
  'When assignment_mode last became auto_all. A supplier_assignment / lead assignment newer than this overrides the auto spread.';

-- supplier_assignment.updated_at already carries this. Leads need their own
-- column: leads_in_flight.updated_at moves for every enrichment pass, so it
-- cannot distinguish "an operator claimed this lead" from "an agent touched it".
alter table public.leads_in_flight
  add column if not exists assigned_operator_at timestamptz;

comment on column public.leads_in_flight.assigned_operator_at is
  'When assigned_operator_id was last set by a human. Null = never manually assigned (auto keeps ownership under auto_all).';

-- Orgs already on auto_all chose it before this column existed. Stamping them
-- now would make every pre-existing claim look older than the choice, which is
-- the correct reading: those claims predate the reassignment.
update public.orgs
   set assignment_auto_all_at = now()
 where assignment_mode = 'auto_all'
   and assignment_auto_all_at is null;
