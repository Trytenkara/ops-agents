-- Collapse the review-status vocabulary to the 3 tiers operators actually use, and
-- give the pipeline a clean "agents are done, humans own it now" boundary:
--
--   draft         = incomplete, agents still filling blanks (agents may write)
--   pending_review= agents have nothing left to add; ready for first human review
--   final_review  = final review and approval
--
-- 'ready_for_submission' and 'submitted' are retired: they never carried a distinct
-- meaning operators acted on, and both sit past the point where a human has taken
-- over, so they fold into 'final_review'. Applied to both tables that share this
-- column (quote_profiles and supplier_profiles) so the vocab is uniform in the UI.

-- Drop the old checks FIRST: the backfill writes 'final_review', which the old
-- constraint would reject, so the constraint has to be gone before the update runs.
alter table public.quote_profiles
  drop constraint if exists quote_profiles_approval_status_check;
alter table public.supplier_profiles
  drop constraint if exists supplier_profiles_approval_status_check;

update public.quote_profiles
  set approval_status = 'final_review'
  where approval_status in ('ready_for_submission', 'submitted');

update public.supplier_profiles
  set approval_status = 'final_review'
  where approval_status in ('ready_for_submission', 'submitted');

alter table public.quote_profiles
  add constraint quote_profiles_approval_status_check
  check (approval_status in ('draft', 'pending_review', 'final_review'));

alter table public.supplier_profiles
  add constraint supplier_profiles_approval_status_check
  check (approval_status in ('draft', 'pending_review', 'final_review'));
