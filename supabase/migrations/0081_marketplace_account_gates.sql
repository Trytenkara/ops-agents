-- Migration 0081 - structured gate reasons + gate contacts on marketplace_accounts
--
-- Until now the reason a marketplace could not be provisioned lived only as free
-- prose in `last_error` ("HARD GATE: tilley is invite-only. Every /register,
-- /signup,... returns the same SPA shell (202)..."). Useful to read, impossible
-- to filter, count, or act on: nothing can ask "which hosts need a human to be
-- emailed?" or "which are just waiting on marketplace approval?".
--
-- `gate_reason` is that answer as a code. `gate_evidence` keeps the machine
-- detail behind it (routes tried, on-page notices, missing fields) so a later
-- retry can tell a changed site from a re-confirmed gate. `last_error` stays as
-- the human sentence.
--
-- The contact columns exist because most hard gates are not technical problems,
-- they are human ones: the account is opened by a person at the supplier
-- (Frontier opens wholesale accounts through customer care, Tilley is
-- invite-only). Recording where to ask turns a dead row into a next step.

alter table public.marketplace_accounts
  -- Why self-serve provisioning cannot finish. Null = no gate diagnosed
  -- (working account, or never attempted).
  add column if not exists gate_reason text,
  add column if not exists gate_evidence jsonb not null default '{}'::jsonb,
  add column if not exists gate_checked_at timestamptz,
  -- Who to ask for an account when the gate needs a human.
  add column if not exists contact_name text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text,
  add column if not exists contact_url text,
  add column if not exists contact_source text,
  add column if not exists contact_notes text,
  add column if not exists contact_resolved_at timestamptz;

-- Codes, not prose. Anything outside this set is a bug in the classifier, so the
-- constraint is deliberately strict rather than advisory.
alter table public.marketplace_accounts
  drop constraint if exists marketplace_accounts_gate_reason_check;
alter table public.marketplace_accounts
  add constraint marketplace_accounts_gate_reason_check check (
    gate_reason is null or gate_reason in (
      'invite_only',            -- no registration route exists at all
      'application_only',       -- self-serve signup disabled; account opened by application/phone
      'email_confirm_required', -- registered, but login needs a click in an inbox we do not read
      'pending_approval',       -- registered and confirmed; marketplace has not approved it yet
      'captcha_wall',           -- a captcha we cannot solve stands in front of signup/login
      'already_registered',     -- the address is taken; needs a password reset by hand
      'needs_client_data',      -- the form demands data the client's own records do not hold
      'no_signup_form',         -- no registration form at any known path; its URL must be supplied
      'login_rejected',         -- credentials exist but the site refuses them for an unknown reason
      'not_needed',             -- prices are public; the login flag was a false positive
      'unclassified'            -- outcome could not be diagnosed; inspect the session
    )
  );

-- The working query is "show me the gates", so index the diagnosed rows only.
create index if not exists marketplace_accounts_gate_reason_idx
  on public.marketplace_accounts (gate_reason)
  where gate_reason is not null;
