-- Multiple marketplace logins per site, with provenance.
--
-- Until now a marketplace account was one-per-(org, host) and only the
-- browserbase-price-pull skill ever created one. Ops also creates logins by
-- hand (a buyer account with different pricing, a second seat, a login made
-- during a manual price check), so the Supplier Validation tab needs to hold
-- several per marketplace and say who made each one.
--
--   created_by / created_by_email  'agent' (fleet-provisioned) or 'ops' plus the
--                                  operator's email, so credentials are attributable.
--   supplier_profile_id            ties the login to the marketplace supplier
--                                  profile it belongs to; null for org-level
--                                  accounts the agent provisioned by host alone.
--
-- Uniqueness moves to (org_id, host, lower(signup_email)): same marketplace,
-- different account = a new row; same email twice = still a conflict.

alter table public.marketplace_accounts
  drop constraint if exists marketplace_accounts_org_id_host_key;

alter table public.marketplace_accounts
  add column if not exists created_by text not null default 'agent',
  add column if not exists created_by_email text,
  add column if not exists supplier_profile_id uuid references public.supplier_profiles(id) on delete set null;

alter table public.marketplace_accounts
  drop constraint if exists marketplace_accounts_created_by_check;

alter table public.marketplace_accounts
  add constraint marketplace_accounts_created_by_check check (created_by in ('agent', 'ops'));

create unique index if not exists marketplace_accounts_org_host_email_idx
  on public.marketplace_accounts (org_id, host, lower(signup_email));

create index if not exists marketplace_accounts_supplier_profile_idx
  on public.marketplace_accounts (supplier_profile_id);
