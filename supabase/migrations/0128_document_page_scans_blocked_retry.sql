-- Migration 0128 - document_page_scans: a blocked page is not a scanned page
--
-- PERS-03. The scan row is written unconditionally, including for a 403, a 429
-- and for the exception path that synthesises `errors: 1`. `last_scanned_at`
-- then removes the page from the queue for RESCAN_AFTER_DAYS, so a page that
-- was never read at all rests for sixty days exactly as if it had been read and
-- found to carry nothing. The agent's own header records this as the real
-- ceiling: 10 of 80 pages returned 403 or 429 on the first live run.
--
-- `retry_after` overrides the sixty-day clock for those pages, on a short
-- lengthening ladder, and `blocked_passes` bounds it so a permanently walled
-- page settles rather than being re-fetched forever.

alter table public.document_page_scans
  add column if not exists blocked_passes int not null default 0,
  add column if not exists retry_after timestamptz;

create index if not exists document_page_scans_retry_idx
  on public.document_page_scans (retry_after)
  where retry_after is not null;
