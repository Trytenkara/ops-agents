-- Whitecat Final Setup SQL
-- Run this in Supabase SQL editor after migration 0117_org_subject_prefix.sql is applied
-- This sets up the [WC] subject prefix for Whitecat org

-- Apply migration if not already applied by Supabase
ALTER TABLE public.orgs ADD COLUMN IF NOT EXISTS subject_prefix text;

COMMENT ON COLUMN public.orgs.subject_prefix IS
  'Optional org-specific prefix to prepend to outreach subject lines (e.g., "[WC]" for Whitecat). Applied after the SR reference: "SR-20260731-0042 [WC]: Subject". Null means no prefix.';

-- Set Whitecat's subject prefix to [WC]
UPDATE public.orgs
SET subject_prefix = '[WC]'
WHERE slug = 'whitecat';

-- Verify the update
SELECT id, slug, name, subject_prefix, tenkara_email_address, sourcing_status
FROM public.orgs
WHERE slug = 'whitecat';
