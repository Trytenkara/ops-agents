-- Migration 0120 - put the client back into three unique keys.
--
-- Same defect in three tables: the key that decides "have we already got this
-- one?" was missing the org, so one client's row answered for every client.
-- This is the storage-layer half of src/lib/org-isolation.ts; that module can
-- only scope the keys we build in application code, not a unique constraint.
--
-- 1. supplier_email_context was UNIQUE (supplier_email) — one shared row per
--    supplier address across the whole fleet. Agent 13 merged every client's
--    conversation with that supplier into it: message counts, latest
--    conversation id, and an LLM-written summary. Six rows were holding one
--    client's negotiation summary under another client's org_id, and Agent 02
--    reads this table to choose its tone.
--
-- 2. document_page_scans had page_hash (a sha1 of the URL alone) as its PRIMARY
--    KEY, while the documents it finds are stored per-org. The first client to
--    scan a supplier's SDS page therefore blocked every other client from
--    scanning it for RESCAN_AFTER_DAYS (60), and those clients' qualification
--    packs stayed silently empty.
--
-- 3. lead_scanner_exports had no org at all, so Agent 11's 7-day "already
--    exported this supplier" suppression was fleet-wide: one client's export
--    silenced another client's.
--
-- NULLS NOT DISTINCT is deliberate: a null org must collide with another null
-- org, otherwise an unattributed row can be inserted without limit. Every
-- existing row in both tables already carries an org, so no dedup is needed
-- before the constraints go on, and the new keys are strictly looser than the
-- old ones — nothing that fits today can fail to fit afterwards.

-- 1. supplier_email_context ---------------------------------------------------
alter table public.supplier_email_context
  drop constraint if exists supplier_email_context_supplier_email_key;

alter table public.supplier_email_context
  add constraint supplier_email_context_org_email_key
  unique nulls not distinct (org_id, supplier_email);

comment on column public.supplier_email_context.supplier_email is
  'The contact address we matched on. Unique per (org_id, supplier_email): one context row per address PER CLIENT, never one shared row.';

-- 2. document_page_scans ------------------------------------------------------
alter table public.document_page_scans
  drop constraint if exists document_page_scans_pkey;

alter table public.document_page_scans
  add constraint document_page_scans_org_page_key
  unique nulls not distinct (org_id, page_hash);

-- page_hash is no longer unique on its own, but it is still the lookup column
-- for tracing a supplier_documents row ('url:<hash>') back to its scan.
create index if not exists document_page_scans_hash_idx
  on public.document_page_scans (page_hash);

comment on column public.document_page_scans.page_hash is
  'sha1 of the page URL. NOT unique on its own — unique per (org_id, page_hash), because documents are stored per-org and one client scanning a page must not skip it for the others.';

-- 3. lead_scanner_exports -----------------------------------------------------
alter table public.lead_scanner_exports
  add column if not exists org_id uuid references public.orgs(id) on delete set null;

create index if not exists lead_scanner_exports_org_idx
  on public.lead_scanner_exports (org_id, supplier_id, generated_at desc);

comment on column public.lead_scanner_exports.org_id is
  'Which client this export belongs to. The recent-export suppression must filter on it, or one client''s export silences another client''s.';
