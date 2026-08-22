-- UI-06. A home for audit findings.
--
-- Agent 26 has been checking the five rules no build check can see, and then
-- posting the result to Slack. A Slack message is not a surface: it scrolls
-- away, it is not scoped to the client the finding belongs to, and nothing can
-- count what is still open. So the registry in src/lib/flagged-work.ts, which
-- is what puts a flagged set on the owning client's own tab, had nothing to
-- read - findings lived nowhere, so they could not be in the registry, so
-- UI-06 could not be satisfied for the one set it names by name.
--
-- One row per (rule, org) while it is open. The audit re-runs daily and
-- re-states the same finding, so a re-statement updates the open row rather
-- than piling up duplicates, and first_seen_at keeps saying how long the thing
-- has been true. A finding the audit stops reporting is resolved, not deleted:
-- how long it took to clear is the only measure of whether the surface worked.
create table if not exists public.audit_findings (
  id            uuid primary key default gen_random_uuid(),
  rule          text not null,
  org_id        uuid references public.orgs(id) on delete cascade,
  detail        text not null,
  count         integer not null default 0,
  sample        jsonb not null default '[]'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz
);

-- Fleet-wide findings carry no org. Postgres treats nulls as distinct in a
-- unique index, which would let one rule open an unbounded number of identical
-- fleet rows, so the key folds null onto a fixed uuid.
create unique index if not exists audit_findings_open_key
  on public.audit_findings (rule, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where resolved_at is null;

create index if not exists audit_findings_org_open
  on public.audit_findings (org_id, last_seen_at desc)
  where resolved_at is null;
