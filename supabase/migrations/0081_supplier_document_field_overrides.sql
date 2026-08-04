-- Migration 0081 - operator-editable parsed document fields
--
-- The fields we pull out of a CoA/SDS/TDS come from a model reading a PDF, and it
-- is wrong often enough to matter: assay_percent comes back null on CoAs that
-- clearly state a purity, and a scanned document can lose a lot number entirely.
-- An operator reading the same PDF on the bench should be able to fix it.
--
-- Corrections go in their OWN column rather than being written back over
-- `extracted`. Re-fetching a document re-parses it, and a fresh parse must never
-- silently destroy a human correction. Same rule as the pre-order requirement
-- ticks: fill from automation, never overwrite the operator.
--
-- Read-time merge is `extracted` <- `extracted_overrides` (see mergedDocFields).

alter table public.supplier_documents
  add column if not exists extracted_overrides jsonb not null default '{}'::jsonb,
  add column if not exists extracted_edited_by text,
  add column if not exists extracted_edited_at timestamptz;

comment on column public.supplier_documents.extracted_overrides is
  'Operator corrections to the parsed fields. Wins over `extracted` at read time; never written by the extractor.';
