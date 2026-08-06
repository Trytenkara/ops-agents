-- Thread reconciliation state for the Agent 15 sweep.
--
-- Tenkara only fires message.received for conversations our agents already
-- touched, and a manual thread MERGE moves message rows between conversations
-- in place without emitting any event. Both cases leave a real supplier reply
-- sitting in a thread we track with no webhook ever delivered, so the agent
-- reads the thread as silence and escalates to a call while a quote sits in it.
-- The sweep polls tracked threads and replays anything unseen; these two tables
-- are its cadence state and its dedup ledger.

-- Which inbound messages have already been through handleInboundReply. Written
-- for EVERY replay attempt regardless of outcome, so a message that legitimately
-- produces no draft (bounce, max reply turns, no API key) is not retried forever.
create table if not exists public.inbound_message_ledger (
  message_id text primary key,
  conversation_id text,
  sender_email text,
  outcome text,
  result jsonb,
  processed_at timestamptz not null default now()
);
create index if not exists inbound_message_ledger_conv_idx
  on public.inbound_message_ledger(conversation_id);

-- Per-thread polling cadence. Tenkara caps conversation reads at 60/min and the
-- rest of the fleet draws on the same budget, so the sweep cannot poll every
-- tracked thread every run. Each thread carries its own next_check_at and the
-- sweep serves the most-overdue first, which makes the read budget a hard cap and
-- the cadence a priority order rather than a promise.
create table if not exists public.tenkara_thread_reconcile (
  thread_id text primary key,
  -- null = never checked, and sorts ahead of everything so new threads go first.
  next_check_at timestamptz,
  last_checked_at timestamptz,
  -- Timestamp of the newest message Tenkara reports on the thread. Drives the
  -- cadence tier: a thread nobody has written on in months does not need polling
  -- at the same rate as one mid-conversation.
  last_message_at timestamptz,
  last_status int,
  merged_into text,
  replayed_last int not null default 0
);
create index if not exists tenkara_thread_reconcile_due_idx
  on public.tenkara_thread_reconcile(next_check_at asc nulls first);

-- Seed the ledger from every inbound message we have already handled. Without
-- this the first sweep would treat the entire reply history as unseen and redraft
-- a reply to every supplier who ever wrote back.
insert into public.inbound_message_ledger (message_id, conversation_id, sender_email, outcome)
select distinct on (m.message_id) m.message_id, m.conversation_id, m.sender_email, 'seeded'
from (
  select metadata->>'in_reply_to_message_id' as message_id,
         thread_id as conversation_id,
         null::text as sender_email
  from public.draft_references
  where email_client = 'rod_app' and metadata->>'in_reply_to_message_id' is not null
  union all
  select metadata->'reply_detected'->>'reply_message_id',
         metadata->'reply_detected'->>'reply_conversation_id',
         metadata->'reply_detected'->>'reply_sender_email'
  from public.draft_references
  where email_client = 'rod_app' and metadata->'reply_detected'->>'reply_message_id' is not null
  union all
  select message_id, conversation_id, sender_email
  from public.unmatched_inbound_events
  where message_id is not null
) m
where m.message_id is not null
on conflict (message_id) do nothing;
