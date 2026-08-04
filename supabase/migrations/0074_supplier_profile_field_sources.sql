-- Per-field provenance for supplier_profiles. Records where each auto-filled
-- value came from ("tenkara", "lead", "staged_quote", "web:host"), and marks a
-- field "not_published" once a web pass looked for it and found nothing, so the
-- Supplier Validation card can say WHY a field is blank instead of showing an
-- empty box that reads like a pipeline failure.
alter table public.supplier_profiles
  add column if not exists field_sources jsonb not null default '{}'::jsonb;
