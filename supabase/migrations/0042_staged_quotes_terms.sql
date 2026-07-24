-- Migration 0042 - staged_quotes terms
--
-- Pull lead time, MOQ, and payment terms out of the free-text extraction_notes
-- blob and into structured columns. Both extractors (reply-quote-extract.ts and
-- email-scanner/attachment-parser.ts) already surface these facts to the model;
-- they were just being dumped into notes. Structured columns let the per-client
-- "Platform extraction" surface (Quote board) show them as fields ops can pull.
--
-- lead_time_days is the normalized numeric (business-agnostic) day count when the
-- supplier states one; lead_time_text keeps the raw phrasing ("2-3 weeks", "ARO")
-- so nothing is lost to normalization. moq_quantity/moq_unit mirror the
-- price/case_size split. payment_terms is free text ("Net 30", "50% deposit").

alter table public.staged_quotes
  add column if not exists lead_time_days integer,
  add column if not exists lead_time_text text,
  add column if not exists moq_quantity numeric(14,4),
  add column if not exists moq_unit text,
  add column if not exists payment_terms text;
