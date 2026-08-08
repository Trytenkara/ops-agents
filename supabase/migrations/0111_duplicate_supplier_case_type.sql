-- Agent 20 parks a lead that would become a duplicate supplier in Tenkara and
-- opens a case so an operator decides. Register the case type.
alter table public.cases drop constraint if exists cases_type_check;
alter table public.cases add constraint cases_type_check check (
  type = any (array[
    'price_change',
    'lead_time_change',
    'availability_change',
    'quality_change',
    'po_timing',
    'client_info_request',
    'archive_request',
    'calling_escalation',
    'supplier_form',
    'manual_outreach',
    'marketplace_price_pull',
    'unmatched_inbound',
    'duplicate_supplier',
    'other'
  ])
);

-- One case per lead, ever. The sweep re-reads the same parked leads every run,
-- so without this each pass would open another identical case.
create unique index if not exists duplicate_supplier_case_lead_idx
  on public.cases (org_id, ((metadata->>'lead_id')))
  where type = 'duplicate_supplier';

-- Superseded before it was used: merging existing Tenkara suppliers was a
-- review surface over data this app cannot write to. The guard prevents the
-- duplicate at the lead instead, which is a table we own.
drop table if exists public.supplier_dupe_decisions;
