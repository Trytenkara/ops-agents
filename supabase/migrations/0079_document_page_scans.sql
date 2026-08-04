-- Migration 0079 - document_page_scans
--
-- Which product/supplier pages Agent 09 has already looked at for SDS/CoA links.
-- Without this the queue can only skip pages that yielded a document, so the two
-- thirds of pages that carry none would be re-fetched on every run forever, and
-- the agent would never reach the back of the backlog.
--
-- It also holds the rescan clock. Pages are worth revisiting occasionally (a
-- supplier posts an SDS later, or replaces one with a new revision), but on a
-- much slower cycle than the price pull.

create table if not exists public.document_page_scans (
  -- sha1 of the page URL, matching the synthetic source_message_id the retriever
  -- writes onto supplier_documents ('url:<hash>'), so a document row can be
  -- traced back to the scan that found it.
  page_hash       text primary key,
  page_url        text not null,
  org_id          uuid references public.orgs(id) on delete cascade,
  supplier_id     uuid,
  supplier_name   text,

  last_scanned_at timestamptz not null default now(),
  scan_count      int not null default 1,
  docs_found      int not null default 0,
  -- Why a scan found nothing: 'no document links found', 'page fetch 403', a
  -- timeout. Blocked pages (403/429) are the ones worth escalating to a real
  -- browser later, so the reason has to survive.
  note            text
);

create index if not exists document_page_scans_org_idx on public.document_page_scans (org_id);
create index if not exists document_page_scans_due_idx on public.document_page_scans (last_scanned_at);

alter table public.document_page_scans enable row level security;

drop policy if exists document_page_scans_read on public.document_page_scans;
create policy document_page_scans_read on public.document_page_scans for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );
