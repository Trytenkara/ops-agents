-- Migration 0013 - register Agent 04 (Outreach).
-- Embedded, manual-only first run. Consumes stage='enriched' leads produced by
-- Agent 06, composes a deterministic outreach email (no LLM in v1), stages a
-- Missive draft, and bumps the lead to stage='ready_for_outreach'. The Missive
-- client refuses send=true and from_field at both compile- and runtime, so no
-- email is ever delivered without a human pressing Send.
--
-- training_wheels_mode=true so the first runs are visibly cautious — the UI
-- can surface that and operators know to review every draft.

insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, prompt)
values (
  'agent-04-outreach',
  'Agent 04 - Outreach',
  'Composes outreach emails for enriched leads, stages them as Missive drafts (never sends), and promotes leads to stage=ready_for_outreach. Deterministic templates in v1 - no LLM.',
  'embedded',
  true,
  true,
  null,
  null
)
on conflict (slug) do update set
  runtime = 'embedded',
  name = excluded.name,
  description = excluded.description;
