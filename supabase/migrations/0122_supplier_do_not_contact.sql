-- Ops-owned do-not-contact list.
--
-- The client can already configure a do-not-contact list in their own settings
-- (read read-only from Tenkara). Ops had no equivalent: dropping a lead ends one
-- lead, and the next discovery pass rediscovers the same company and writes the
-- same email again. This is the list ops writes to.
--
-- Scope is one org, because the same company can be off-limits for one client
-- and a fine supplier for another. Matching is by Tenkara supplier id when we
-- have one, and by normalized company name or website host when we do not
-- (discovery hands over plenty of companies with no supplier id yet).

create table if not exists supplier_do_not_contact (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  supplier_id   text,          -- Tenkara supplier id when known
  company_name  text,          -- as typed/observed, for display
  name_key      text,          -- normalized company name used for matching
  host          text,          -- website host, lowercased, no www.
  email         text,          -- optional: block one address rather than the company
  reason        text,
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  removed_at    timestamptz,
  removed_by    uuid references public.users(id) on delete set null,
  check (supplier_id is not null or name_key is not null or host is not null or email is not null)
);

create index if not exists supplier_dnc_org_supplier on supplier_do_not_contact (org_id, supplier_id) where removed_at is null;
create index if not exists supplier_dnc_org_name on supplier_do_not_contact (org_id, name_key) where removed_at is null;
create index if not exists supplier_dnc_org_host on supplier_do_not_contact (org_id, host) where removed_at is null;
create index if not exists supplier_dnc_org_email on supplier_do_not_contact (org_id, email) where removed_at is null;

alter table supplier_do_not_contact enable row level security;
