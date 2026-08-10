-- One row per distinct alert condition, so the fleet stops re-announcing the
-- same thing every run.
--
-- Before this, 7 of the 23 Slack post sites had no persisted "already told you"
-- marker: agent-07's nudge writes nothing at all by design, the QA watchdog and
-- sourcing-health re-post identical counts each run, and a persistently failing
-- agent DM'd every run because the 1h debounce in safety-alerts was only wired
-- into error events. Combined with per-item posting inside loops (the contact
-- guard produced 123 of 148 messages in #op-assistant-agents over 14 days),
-- ops stopped reading the channel, which defeats the point of a watchdog.
--
-- Keyed on a caller-supplied alert_key that identifies the CONDITION, not the
-- occurrence, e.g. "blocked_draft:<supplier_id>" rather than a draft id. Same
-- key + same content_hash inside the TTL is counted, not posted.

create table if not exists public.slack_alert_log (
  alert_key text primary key,
  -- p1 posts live, p2 waits for the daily fleet digest, p3 never reaches Slack
  -- (its caller already writes a case or flag row that operators can act on).
  severity text not null check (severity in ('p1', 'p2', 'p3')),
  -- Hash of the rendered text. A changed hash means the situation moved and is
  -- worth saying again even inside the TTL.
  content_hash text not null,
  title text,
  body text,
  channel text,
  -- Grouping label for the daily digest, so 12 held drafts read as one line.
  digest_group text,
  -- Set when the alert actually reached a human, live or via the digest. TTL is
  -- measured from here. For p3 it is stamped on first record so repeat
  -- dispatches take the cheap suppressed path.
  last_notified_at timestamptz,
  last_seen_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  -- Times the condition re-occurred while suppressed. Surfaced in the digest so
  -- a window is never silently hidden.
  suppressed_count integer not null default 0,
  -- Waiting to be picked up by the next fleet digest.
  queued boolean not null default false,
  slack_ts text
);

-- The digest drain reads exactly this predicate.
create index if not exists slack_alert_log_queued_idx
  on public.slack_alert_log (queued, digest_group)
  where queued = true;

comment on table public.slack_alert_log is
  'Dedupe/queue ledger for agent Slack alerts. p1 posts live, p2 rolls into the daily fleet digest, p3 is recorded only. See src/lib/alert-policy.ts.';
