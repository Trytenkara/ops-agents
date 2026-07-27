-- Self-serve client email setup (Control Room). Lets ops onboard a real client's
-- outreach by pasting their Tenkara Inbox account UUID, instead of a code deploy
-- that edits TENKARA_EMAIL_ACCOUNT_IDS + ACTIVE_CLIENTS in the app source.
--
-- When tenkara_email_account_id is set on an org:
--   * cold outbound (Agent 04) and re-quote (Agent 02) drafts send from this inbox
--     (overriding the hardcoded brand map), and
--   * the org is treated as an ACTIVE outreach client regardless of the
--     ACTIVE_CLIENTS / SKIP_CLIENTS lists.
-- Outreach is still gated by sourcing_status='active' (see migration 0045), so
-- pasting an inbox id alone does not start sending — ops still flips the toggle.
alter table orgs
  add column if not exists tenkara_email_account_id text,
  add column if not exists tenkara_email_address text;

comment on column orgs.tenkara_email_account_id is
  'Tenkara Inbox account UUID (email_account_id) this org sends outreach from. When set, self-serve active outreach client — overrides the hardcoded brand map. Sourced from the Tenkara Inbox app.';
comment on column orgs.tenkara_email_address is
  'Display-only sending address paired with tenkara_email_account_id (e.g. purchasing@californiachemicals.com).';
