-- Migration 0078 - store supplier document bytes, and record where they came from
--
-- 0043 deliberately kept a download URL and no bytes, because every document
-- then arrived as an email attachment that stayed retrievable from Tenkara.
-- Web-retrieved documents break that assumption twice over: a supplier can
-- reorganise their site and turn the link into a 404, and (worse) can replace
-- the file at the same URL with a new revision, so "we checked their SDS in
-- August" silently becomes a claim about whatever is there today. A stored copy
-- plus a content hash makes the check evidence rather than a pointer.

alter table public.supplier_documents
  -- Path inside the private 'supplier-docs' bucket. Null means bytes were not
  -- captured (every row written before this migration).
  add column if not exists storage_path text,
  -- sha256 of the stored bytes. Re-fetching the same URL later and getting a
  -- different hash is the signal that the supplier revised the document.
  add column if not exists content_sha256 text,
  add column if not exists retrieved_at timestamptz,
  -- 'email' = inbound attachment (0043's original path), 'web' = scraped from a
  -- product or supplier page.
  add column if not exists source_kind text not null default 'email'
    check (source_kind in ('email', 'web')),
  -- Whether the document is the supplier's own, or a third-party reference copy
  -- (a substance SDS from a chemical database). Both are useful, but only a
  -- supplier-issued document qualifies the supplier, so the bench must not
  -- count a reference sheet as a met requirement.
  add column if not exists supplier_issued boolean;

create index if not exists supplier_documents_hash_idx
  on public.supplier_documents (org_id, content_sha256);

-- Private bucket for supplier qualification documents. Downloads go through an
-- authenticated app route that mints short-lived signed URLs, same as
-- 'supplier-forms' (0034).
insert into storage.buckets (id, name, public)
values ('supplier-docs', 'supplier-docs', false)
on conflict (id) do nothing;
