-- Slack member id for an operator, so an escalation that needs a human can
-- actually @mention them instead of printing their name into a channel nobody
-- has notifications on. Nullable: unset just degrades to a plain-text name.
alter table public.users add column if not exists slack_user_id text;

comment on column public.users.slack_user_id is
  'Slack member id (U…), used to @mention the assigned operator on escalations.';
