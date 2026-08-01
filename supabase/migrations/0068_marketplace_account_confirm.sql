-- Auto-confirm loop for marketplace signups: the confirmation email lands in the
-- org's Tenkara-managed inbox, the message.received webhook extracts the confirm
-- link and clicks it. confirm_url stores the extracted link (for the
-- container-side Browserbase clicker when a plain fetch isn't enough);
-- confirmed_via records which mechanism activated the account.
alter table marketplace_accounts
  add column if not exists confirm_url text,
  add column if not exists confirmed_via text;
