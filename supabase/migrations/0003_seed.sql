-- Phase 1 seed: Meridian Foods org, Agent 02.
insert into public.orgs (slug, name, tenkara_org_id)
values ('meridian-foods', 'Meridian Foods', null)
on conflict (slug) do nothing;

insert into public.agents (slug, name, description, training_wheels_mode, stamp_of_approval, schedule_cron)
values (
  'agent-02-revalidation',
  'Agent 02 — Quote Revalidation',
  'Drafts revalidation outreach for expiring quotes and stages them in Missive for human review.',
  true,
  false,
  '0 8 * * 1-5'
)
on conflict (slug) do nothing;
