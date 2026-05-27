-- Migration 0014 - register Agents 05 (Marketplace Validation), 07 (Escalation),
-- and 10 (QA Outreach). All embedded, manual-only first run.
--
-- These are the "quieter" agents in the spec — they read state produced by
-- the pipeline agents (03 → 06 → 04) and flag drift / staleness / quality
-- issues. None of them send email, write to Tenkara, or stage Missive drafts.

insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, prompt)
values
  (
    'agent-05-marketplace-validation',
    'Agent 05 - Marketplace Validation',
    'Re-verifies catalog-match leads against Tenkara`s current supplier_catalog_materials. Flags payload.catalog_drift when a supplier no longer lists a material we sourced from them. Read-only on Tenkara; writes only flags to OA.',
    'embedded', false, true, null, null
  ),
  (
    'agent-07-escalation',
    'Agent 07 - Escalation',
    'Sweeps stale leads (status=active, updated_at older than 14d) and opens a case for the assigned operator so nothing rots silently. Bumps lead.status to dropped with drop_reason=escalated_to_case.',
    'embedded', false, true, null, null
  ),
  (
    'agent-10-qa-outreach',
    'Agent 10 - QA Outreach',
    'Lints staged outreach drafts (older than 1h) for placeholders, broken templates, missing assigned_operator. Writes findings to draft_references.metadata.qa_findings so operators see issues before sending.',
    'embedded', false, true, null, null
  )
on conflict (slug) do update set
  runtime = 'embedded',
  name = excluded.name,
  description = excluded.description;
