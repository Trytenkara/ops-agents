-- Re-check existing leads when a client's requirements change.
--
-- orgs.onboarding_stage: where the client is in their lifecycle. 'motherlode' is
-- the early wide-net stage (surface everyone); 'onboarded' applies the tighter
-- bar in src/lib/onboarded-bar.ts. Default 'motherlode' so every existing and new
-- org keeps today's behavior until someone flips it.
--
-- client_tenkara_settings.requirements_hash: the fingerprint of the requirements
-- (see src/lib/requirements-fingerprint.ts) that the last COMPLETED re-check ran
-- against. Agent 12 re-checks an org whenever the live fingerprint differs, and
-- only records it once a pass finished without truncating, so an interrupted pass
-- resumes on the next cycle instead of being marked done.
--
-- db-push re-runs every migration on every deploy, so all of this is idempotent.

alter table orgs add column if not exists onboarding_stage text not null default 'motherlode';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'orgs_onboarding_stage_check') then
    alter table orgs add constraint orgs_onboarding_stage_check
      check (onboarding_stage in ('motherlode', 'onboarded'));
  end if;
end $$;

alter table client_tenkara_settings add column if not exists requirements_hash text;
alter table client_tenkara_settings add column if not exists requirements_checked_at timestamptz;
