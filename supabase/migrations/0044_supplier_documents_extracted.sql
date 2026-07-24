-- Migration 0044 - supplier_documents extracted content
--
-- Beyond recording that a qualification doc arrived (0043), we now parse key
-- fields out of it (CoA lot/assay/expiry, certificate validity, SDS revision,
-- etc.). `extracted` holds the doc-type-specific fields as-is; `expires_on` is
-- promoted to a first-class column because it's the cross-type field ops care
-- about most (retest/expiry/valid-until) and wants to sort/flag on.

alter table public.supplier_documents
  add column if not exists extracted jsonb not null default '{}'::jsonb,
  add column if not exists expires_on date;

create index if not exists supplier_documents_expires_idx
  on public.supplier_documents (org_id, expires_on);
