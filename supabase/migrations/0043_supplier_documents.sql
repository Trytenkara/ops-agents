-- Migration 0043 - supplier_documents
--
-- Qualification documents a supplier emailed us (CoA, SDS, TDS, certificates,
-- statements, etc.), captured from inbound reply attachments. Agent 15 asks for
-- them (per the client's Tenkara Sourcing Rules); this is where the returned
-- files get recorded so the Platform Extraction "The bench" can show what has
-- been received vs. what the client requires.
--
-- Same pipeline shape as staged_quotes: OA-only, Tenkara is never written. We
-- store provenance + a download URL, not the file bytes. Price sheets keep going
-- to staged_quotes (extracted for pricing); a file classified as price_sheet is
-- recorded here too so "what did they send" is complete.

create table if not exists public.supplier_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete set null,

  -- Tenkara identifiers when known (read-only; stored, never written back).
  supplier_id uuid,
  supplier_name text,
  material_id uuid,

  -- What kind of document this is (best-effort classification from filename +
  -- content type). 'other' when we can't tell.
  doc_type text not null default 'other'
    check (doc_type in ('coa','sds','tds','certificate','statement','testing','price_sheet','other')),

  file_name text,
  content_type text,
  size_bytes bigint,

  -- Provenance back to the email so ops can open the original.
  source_conversation_id text,
  source_message_id text,
  source_url text,

  created_at timestamptz not null default now()
);

create index if not exists supplier_documents_org_idx on public.supplier_documents (org_id);
create index if not exists supplier_documents_supplier_idx on public.supplier_documents (supplier_id);
create index if not exists supplier_documents_type_idx on public.supplier_documents (org_id, doc_type);
create index if not exists supplier_documents_msg_idx on public.supplier_documents (source_message_id);

-- RLS: same shape as staged_quotes (0025). Admin/ops_lead/monitor see all;
-- ops_operator sees rows for orgs they're assigned to. Service role (agent
-- runtime / webhook) bypasses RLS so the inbound handler writes freely.
alter table public.supplier_documents enable row level security;

drop policy if exists supplier_documents_read on public.supplier_documents;
create policy supplier_documents_read on public.supplier_documents for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );
