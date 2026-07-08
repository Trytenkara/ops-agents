-- Add a 'superseded' draft status. When a material spelling is corrected, the
-- already-staged (wrong-spelling) drafts are superseded and regenerated; the old
-- ones stay flagged in the threads view so ops can delete them in the Tenkara
-- inbox (Tenkara drafts can't be discarded via API).
alter table public.draft_references drop constraint if exists draft_references_status_check;
alter table public.draft_references add constraint draft_references_status_check
  check (status in ('staged','reviewed','sent','discarded','superseded'));
