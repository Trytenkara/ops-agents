-- Client onboarding stage (Control Room). Tracks where a client sits in the
-- funnel so the fleet can tighten the bar as a client graduates:
--   motherlode = early/wide-net sourcing — cast broad, surface everyone
--   onboarded  = graduated client — tighter, higher-confidence leads only
-- On the transition motherlode -> onboarded the app runs a bounded, reversible
-- re-filter that FLAGS (never deletes) this org's active leads below the
-- onboarded bar with an advisory payload.below_onboarded_bar, surfaced in the
-- Leads UI. Moving back to motherlode clears that advisory. See
-- src/lib/onboarded-bar.ts for the exact bar and src/app/actions/client-settings.ts
-- (setOrgOnboardingStage) for the re-filter.
-- Default 'motherlode' so every existing/new org keeps the current wide-net behavior.
alter table orgs
  add column if not exists onboarding_stage text not null default 'motherlode'
  check (onboarding_stage in ('motherlode', 'onboarded'));
