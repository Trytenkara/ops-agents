-- Slack email -> member id directory.
--
-- The materials-expiry sweep @-mentions the operator who entered a quote, which
-- means turning an email into a Slack member id. The container skill did that
-- with a live users.lookupByEmail call through Sam's on-behalf Slack account —
-- a credential that only exists on the container, so the sweep could not move to
-- Vercel as written.
--
-- The tenkara_agents bot token cannot do the lookup either: it holds only
-- chat:write / chat:write.public / im:write. Adding users:read + users:read.email
-- lets the sweep refresh this table itself on every run; until then the table is
-- the source of truth and an unknown email simply degrades to a plain-text name.

create table if not exists public.slack_directory (
  -- Lowercased. Slack and Tenkara disagree on case for the same person
  -- (Mildred@trytenkara.com vs mildred@trytenkara.com), so callers must fold.
  email text primary key,
  slack_user_id text not null,
  display_name text,
  deleted boolean not null default false,
  synced_at timestamptz not null default now()
);

comment on table public.slack_directory is
  'Slack email -> member id map, so agents can @mention a person without a users:read.email token. Refreshed by agent-18-materials-expiry when the bot has the scope.';
