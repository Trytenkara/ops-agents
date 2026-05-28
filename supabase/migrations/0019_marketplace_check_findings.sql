-- Migration 0019 - marketplace_check_findings
--
-- Agent 05 (renamed to "Marketplace Price Re-check") writes one row per
-- Tenkara material_quote it re-checks. Each row captures the baseline price
-- (what Tenkara has stored), the current price signal (what the web shows),
-- a classification, and a review status that gates the CSV export for
-- ops -> Tenkara bulk upload.
--
-- Tenkara writes are still prohibited - this table lives in OA only. The
-- approved CSV is downloaded by ops and uploaded to Tenkara via the existing
-- bulk-upload UI; no automatic write-back.

create table if not exists public.marketplace_check_findings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete set null,
  run_id uuid references public.agent_runs(id) on delete set null,

  -- Tenkara identifiers (read-only - we store them, never write back).
  quote_id uuid not null,
  supplier_id uuid not null,
  supplier_name text not null,
  material_id uuid not null,
  material_name text not null,

  -- Pricing.
  baseline_price numeric(12,4),
  current_price  numeric(12,4),
  currency text default 'USD',
  pack_size text,                       -- free-text e.g. "50 lb" - source pages are inconsistent
  pct_change numeric(8,4)
    generated always as (
      case
        when baseline_price is null or baseline_price = 0 or current_price is null then null
        else ((current_price - baseline_price) / baseline_price) * 100
      end
    ) stored,

  -- What the scout decided + where it found it.
  classification text not null check (classification in (
    'signal_matches_baseline',
    'signal_diverges',
    'no_signal_found',
    'needs_review',
    'link_broken'
  )),
  source_url text,
  source_citations jsonb default '[]'::jsonb,
  notes text,

  -- Review workflow.
  status text not null default 'pending_review' check (status in (
    'pending_review','approved','dismissed'
  )),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  dismissed_by uuid references auth.users(id) on delete set null,
  dismissed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mcf_org_status_idx
  on public.marketplace_check_findings (org_id, status);
create index if not exists mcf_supplier_idx
  on public.marketplace_check_findings (supplier_id);
create index if not exists mcf_material_idx
  on public.marketplace_check_findings (material_id);
create index if not exists mcf_pct_change_idx
  on public.marketplace_check_findings (pct_change desc nulls last);
create index if not exists mcf_run_idx
  on public.marketplace_check_findings (run_id);

-- updated_at trigger - reuse the existing helper from 0001_init if present.
create or replace function public.touch_marketplace_check_findings()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_mcf on public.marketplace_check_findings;
create trigger trg_touch_mcf before update on public.marketplace_check_findings
  for each row execute function public.touch_marketplace_check_findings();

-- RLS: same shape as leads_in_flight. Admin/ops_lead/monitor see all rows;
-- ops_operator only sees rows for orgs they're assigned to.
alter table public.marketplace_check_findings enable row level security;

drop policy if exists mcf_read on public.marketplace_check_findings;
create policy mcf_read on public.marketplace_check_findings for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );

-- UPDATE policy: ops_lead/admin can flip status on anything; ops_operator
-- can flip status on rows for orgs they're assigned to. Service role
-- (agent runtime) bypasses RLS so the scout writes freely.
drop policy if exists mcf_update on public.marketplace_check_findings;
create policy mcf_update on public.marketplace_check_findings for update to authenticated
  using (
    public.has_any_role(array['admin','ops_lead'])
    or (public.has_any_role(array['ops_operator']) and public.user_has_org_access(org_id))
  )
  with check (
    public.has_any_role(array['admin','ops_lead'])
    or (public.has_any_role(array['ops_operator']) and public.user_has_org_access(org_id))
  );

-- Rename the registered Agent 05 to match its new behavior. Keep the slug
-- stable so cron + agent_runs history don't break.
update public.agents
set
  name = 'Agent 05 - Marketplace Price Re-check',
  description = 'Re-checks current public pricing on Tenkara marketplace quotes that are expiring within 7 days. Uses Anthropic web_search to find a current price signal per quote and writes findings to marketplace_check_findings for ops review. Read-only on Tenkara; never writes back. CSV of approved findings is exported and uploaded manually via Tenkara`s bulk-upload UI.'
where slug = 'agent-05-marketplace-validation';
