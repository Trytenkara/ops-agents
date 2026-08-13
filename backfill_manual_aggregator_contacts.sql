-- Backfill contact_source='manual_operator' on aggregator leads in ready_for_approval
-- that have a supplier_contact_email set (indicating operator intervention).
--
-- These leads are stuck waiting for approval because the system treats marketplace
-- emails as suspect by default. Backfilling the flag lets them flow through normal
-- outreach on the next Agent 04 run.

UPDATE leads_in_flight
SET payload = jsonb_set(
  payload,
  '{contact_source}',
  '"manual_operator"'::jsonb,
  true
)
WHERE
  stage = 'ready_for_approval'
  AND status = 'active'
  AND payload->>'marketplace_outreach_review-pending' = 'true'
  AND (payload->>'site_type' IN ('A', 'M', 'MS') OR payload->>'aggregator' IS NOT NULL)
  AND payload->>'supplier_contact_email' IS NOT NULL
  AND (payload->>'contact_source' IS NULL OR payload->>'contact_source' != 'manual_operator')
RETURNING id, supplier_name, material_name, (payload->>'supplier_contact_email') as email;
