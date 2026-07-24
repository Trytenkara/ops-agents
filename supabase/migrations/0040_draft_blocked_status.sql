-- Add a 'blocked' draft status for the anti-fabrication contact guard. When an
-- agent-composed supplier email states a shipping address, phone, or email that
-- isn't on the approved allowlist (BRAND_CONTACTS), stageDraft refuses to create
-- a provider draft and records the attempt as status='blocked' so it can never
-- move through the review->send path (markDraftReviewed only advances 'staged').
-- Ops is alerted via Slack to research the real value.
alter table public.draft_references drop constraint if exists draft_references_status_check;
alter table public.draft_references add constraint draft_references_status_check
  check (status in ('staged','reviewed','sent','discarded','superseded','blocked'));
