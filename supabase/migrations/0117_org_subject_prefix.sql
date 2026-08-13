-- Add optional subject prefix for orgs (e.g. "[WC]" for Whitecat).
-- When set, prepended to outreach subject lines after the SR reference.
alter table public.orgs add column if not exists subject_prefix text;

comment on column orgs.subject_prefix is
  'Optional org-specific prefix to prepend to outreach subject lines (e.g., "[WC]" for Whitecat). Applied after the SR reference: "SR-20260731-0042 [WC]: Subject". Null means no prefix.';
