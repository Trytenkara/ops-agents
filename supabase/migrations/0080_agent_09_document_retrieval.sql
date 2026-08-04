-- Migration 0080 - register Agent 09 (Document Retrieval)
--
-- Slot 09 has been empty since the fleet was numbered. Hourly rather than every
-- few minutes: a document appearing on a supplier's page is not time-sensitive,
-- and each page can cost several PDF downloads plus an extraction call, so the
-- backlog is better drained slowly than raced through. Once a page is recorded
-- in document_page_scans it is not revisited for 60 days, so the agent goes
-- nearly idle after the initial sweep.
--
-- Minute 50 keeps it clear of the other hourly agents (05 at :20, 12 at :40).

insert into public.agents (slug, name, description, runtime, schedule_cron, schedule_tz, training_wheels)
values (
  'agent-09-document-retrieval',
  'Agent 09 - Document Retrieval',
  'Collects supplier qualification documents (SDS/CoA/TDS/certificates) published on product and supplier pages, stores the files, and records which pages have already been checked.',
  'embedded',
  '50 * * * *',
  'Asia/Manila',
  false
)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  runtime = excluded.runtime,
  schedule_cron = excluded.schedule_cron;
