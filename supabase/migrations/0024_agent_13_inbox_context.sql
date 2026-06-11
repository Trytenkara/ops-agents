-- Migration 0024 - register Agent 13 (Inbox Context) + create supplier_email_context.
--
-- Agent 13 reads the Missive team_inbox and builds a per-supplier context row:
-- when we last reached out, when (if) the supplier last replied, the resulting
-- thread state, and a short summary / open ask. Agent 02 reads this before
-- drafting so revalidation outreach uses a follow-up tone (referencing the
-- prior thread) instead of a cold initial email when a conversation exists.
--
-- Read-only on Missive/Tenkara - this table lives in OA only.

create table if not exists public.supplier_email_context (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete set null,
  run_id uuid references public.agent_runs(id) on delete set null,

  -- Tenkara identifiers (read-only - stored, never written back).
  tenkara_org_id text,
  supplier_id uuid,
  supplier_name text,
  -- The contact address we matched on. Unique key: one context row per address.
  supplier_email text not null,

  -- Conversation timeline (unix seconds from Missive, mirrored as timestamptz).
  last_outbound_at timestamptz,        -- last message WE sent in the thread
  last_inbound_at  timestamptz,        -- last message the SUPPLIER sent
  last_message_at  timestamptz,        -- max of the two
  message_count    integer not null default 0,
  latest_conversation_id text,

  -- Derived state used by Agent 02 to choose tone / whether to follow up.
  thread_state text not null default 'never_contacted' check (thread_state in (
    'never_contacted',        -- no thread found for this address
    'awaiting_their_reply',   -- our message is the latest; ball is in their court
    'they_replied',           -- supplier's message is the latest; needs our follow-up
    'stale'                   -- last activity older than the staleness window
  )),

  -- Short LLM (or heuristic) summary + any open ask, for the drafter to weave in.
  summary text,
  open_ask text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (supplier_email)
);

create index if not exists sec_org_idx on public.supplier_email_context (org_id);
create index if not exists sec_supplier_idx on public.supplier_email_context (supplier_id);
create index if not exists sec_state_idx on public.supplier_email_context (thread_state);
create index if not exists sec_last_msg_idx on public.supplier_email_context (last_message_at desc nulls last);
create index if not exists sec_run_idx on public.supplier_email_context (run_id);

-- updated_at trigger (reuse the shared helper from 0001_init).
do $$
begin
  drop trigger if exists trg_touch_supplier_email_context on public.supplier_email_context;
  create trigger trg_touch_supplier_email_context before update on public.supplier_email_context
    for each row execute function public.touch_updated_at();
end$$;

-- RLS: same shape as marketplace_check_findings / leads_in_flight. Admin /
-- ops_lead / monitor see all rows; ops_operator sees rows for orgs they're
-- assigned to. The agent runtime uses the service role and bypasses RLS.
alter table public.supplier_email_context enable row level security;

drop policy if exists sec_read on public.supplier_email_context;
create policy sec_read on public.supplier_email_context for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );

-- Register Agent 13. Scheduled ahead of Agent 02's 07:00 sweep so context is
-- fresh when revalidation drafts. training_wheels_mode=true until we've watched
-- a few real runs populate context correctly.
insert into public.agents (slug, name, description, runtime, training_wheels_mode, stamp_of_approval, schedule_cron, schedule_tz, prompt)
values (
  'agent-13-inbox-context',
  'Agent 13 - Inbox Context',
  'Reads the Missive team_inbox and builds a per-supplier email-context row (last outbound/inbound, thread state, short summary, open ask) so Agent 02 can reach out with the right tone. Read-only on Missive/Tenkara; writes supplier_email_context in OA only.',
  'embedded',
  true,
  true,
  '45 6 * * *',
  'America/New_York',
  null
)
on conflict (slug) do update set
  runtime = 'embedded',
  name = excluded.name,
  description = excluded.description;
