-- OUT-15. An operator discard suppresses the address for good and the email app
-- never tells us why, so we ask afterwards on the client's Email Thread Tracker.
-- Register the case type.
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
    'draft_discarded',
    'other'
  ])
);

-- One open question per supplier and address, ever. Several materials to one
-- supplier discard as several drafts and it is a single decision. The code
-- dedupes too; this makes a race impossible. NULLs (a draft with no supplier
-- resolved) are distinct in a unique index, so those fall back to the code check.
create unique index if not exists draft_discarded_case_supplier_email_idx
  on public.cases (org_id, supplier_id, ((metadata->>'supplier_contact_email')))
  where type = 'draft_discarded' and status <> 'resolved';
