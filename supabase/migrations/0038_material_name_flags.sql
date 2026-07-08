-- Material-name spelling flags. Material names come from Tenkara (read-only), so
-- when a name is misspelled (e.g. "Butylene G;ycol") we can't fix it at source.
-- Agent 03 flags a suggested correction; an operator can apply it, which writes
-- an OA-side canonical override used across the dashboard + outreach copy.
-- status: pending (flagged, awaiting operator), applied (override active),
-- dismissed (operator said the name is fine).
create table if not exists public.material_name_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  wrong_name text not null,
  suggested_name text not null,
  status text not null default 'pending' check (status in ('pending','applied','dismissed')),
  slack_ts text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id)
);

-- One flag per (org, misspelled name) — case-insensitive — so re-scans don't dup.
create unique index if not exists material_name_flags_org_name_idx
  on public.material_name_flags (org_id, lower(wrong_name));
