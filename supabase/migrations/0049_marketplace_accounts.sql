-- Marketplace accounts for gated price pulls (Ben's feature).
--
-- Login-gated marketplaces (knowde, ingredientsonline, …) hide pricing behind a
-- sign-in wall, so Agent 05's web_search recheck returns `login_required` and we
-- can't pull a price. This table stores a per-org account for each such
-- marketplace: the client's purchasing email + a generated password, plus the
-- signup/verification lifecycle. A container-side skill (browserbase-price-pull)
-- creates the account via Browserbase, a human clicks the confirm link once
-- (semi-auto verification), then the skill logs in on a schedule and pulls
-- prices for that org's login_required leads.
--
-- Passwords are stored plaintext behind service-role RLS for the pilot; these
-- are low-value marketplace logins. Encryption-at-rest is a hardening follow-up.

create table if not exists public.marketplace_accounts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.orgs(id) on delete cascade,
  host          text not null,                       -- bare hostname, e.g. 'knowde.com'
  slug          text not null,                       -- adapter slug, e.g. 'KNOWDE'
  signup_email  text not null,                       -- client purchasing email used to register
  password      text not null,                       -- generated at signup
  status        text not null default 'pending',     -- pending|signing_up|verifying|active|failed|banned
  case_id       uuid,                                -- the human "click confirm link" case
  last_error    text,
  verified_at   timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, host)
);

create index if not exists marketplace_accounts_status_idx on public.marketplace_accounts (status);
create index if not exists marketplace_accounts_org_idx on public.marketplace_accounts (org_id);

alter table public.marketplace_accounts enable row level security;

-- The client's purchasing email, used to register gated-marketplace accounts.
-- Populated per org (manually for the pilot; inbox auto-detection is a follow-up).
alter table public.orgs add column if not exists purchasing_email text;
