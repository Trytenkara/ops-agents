-- Ops Assistants — Phase 1 schema
-- Conventions: snake_case, UUID PKs from gen_random_uuid(), timestamptz, soft enums via check constraints.

create extension if not exists "pgcrypto";

-- ============================================================
-- Auth + roles
-- ============================================================

-- Mirror of auth.users with app profile fields.
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  status text not null default 'active' check (status in ('active','out_of_office')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Custom role buckets (per §3 of the outline).
create table if not exists public.roles (
  name text primary key
);
insert into public.roles(name) values
  ('admin'), ('ops_lead'), ('ops_operator'), ('account_manager'), ('monitor')
on conflict do nothing;

create table if not exists public.user_roles (
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null references public.roles(name) on delete restrict,
  primary key (user_id, role)
);

-- ============================================================
-- Orgs (lightweight local mirror; canonical record lives in Tenkara)
-- ============================================================
create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  tenkara_org_id text unique,           -- pointer back to Tenkara
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

-- Primary + optional backup operator per org (§4.4).
create table if not exists public.org_default_operators (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  primary_user_id uuid references public.users(id),
  backup_user_id uuid references public.users(id),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- Agents
-- ============================================================
create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,             -- e.g. 'agent-02-revalidation'
  name text not null,
  description text,
  status text not null default 'idle' check (status in ('idle','running','paused','disabled')),
  training_wheels_mode boolean not null default true,
  stamp_of_approval boolean not null default false,  -- Ben's gate
  prompt_version int not null default 1,
  schedule_cron text,
  webhook_url text,                       -- SuperAgent resume webhook (§6.5)
  api_key_hash text,                      -- sha256(token); raw token stored in SuperAgent
  api_key_prefix text,                    -- first 8 chars for display
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  org_id uuid references public.orgs(id),
  run_started_at timestamptz not null default now(),
  run_finished_at timestamptz,
  status text not null default 'running' check (status in ('running','success','partial','failure')),
  summary text,
  errors jsonb,
  items_processed int default 0,
  token_cost numeric(10,4),
  trigger_source text,                   -- 'cron'|'webhook'|'manual'|'human_resolution'
  metadata jsonb
);
create index if not exists agent_runs_agent_id_started_idx on public.agent_runs(agent_id, run_started_at desc);
create index if not exists agent_runs_org_id_idx on public.agent_runs(org_id);

-- ============================================================
-- Workflow tables
-- ============================================================

-- Email-client-agnostic draft pointer.
create table if not exists public.draft_references (
  id uuid primary key default gen_random_uuid(),
  email_client text not null default 'missive' check (email_client in ('missive','rod_app')),
  thread_id text not null,
  draft_id text not null,
  agent_run_id uuid references public.agent_runs(id),
  agent_id uuid references public.agents(id),
  org_id uuid references public.orgs(id),
  supplier_id text,                      -- Tenkara supplier id (string, schema TBD)
  material_id text,
  quote_id text,
  status text not null default 'staged' check (status in ('staged','reviewed','sent','discarded')),
  assigned_operator uuid references public.users(id),
  reviewer uuid references public.users(id),
  reviewed_at timestamptz,
  body_preview text,                     -- short preview; full content stays in Missive
  subject text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists draft_refs_status_org_idx on public.draft_references(org_id, status);
create index if not exists draft_refs_assigned_idx on public.draft_references(assigned_operator, status);

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  type text not null check (type in (
    'price_change','lead_time_change','availability_change','quality_change',
    'po_timing','client_info_request','archive_request','other'
  )),
  status text not null default 'open' check (status in ('open','in_progress','resolved','dismissed')),
  supplier_id text,
  material_id text,
  originating_thread_id text,
  classification_confidence numeric(3,2),
  recommended_action text,
  assigned_operator uuid references public.users(id),
  resolved_at timestamptz,
  resolution_note text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cases_org_status_idx on public.cases(org_id, status);

create table if not exists public.pending_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  type text not null check (type in ('supplier','quote','escalation_outcome','doc_refresh')),
  payload jsonb not null,
  requested_by_agent uuid references public.agents(id),
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','approved','rejected','needs_edit','ready_for_export','exported')),
  assigned_approver uuid references public.users(id),
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  notes text
);
create index if not exists approvals_org_status_idx on public.pending_approvals(org_id, status);

create table if not exists public.escalations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id),
  trigger_quote_id text,
  trigger_case_id uuid references public.cases(id),
  recommended_action text not null check (recommended_action in (
    'call_supplier','archive_supplier','feedback_to_enrichment','escalate_to_ops_lead'
  )),
  assigned_operator uuid references public.users(id),
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  resolution text,
  slack_message_ts text,
  urgency text not null default 'normal' check (urgency in ('normal','urgent')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.leads_in_flight (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id),
  supplier_name text,
  supplier_id text,
  material_name text,
  material_id text,
  stage text not null check (stage in ('raw_discovery','gap_analysis','approval','exported')),
  status text not null default 'active' check (status in ('active','dropped','terminal')),
  source text,                           -- 'ai'|'marketplace'|'db_pull'|'scraped'
  payload jsonb,
  agent_run_id uuid references public.agent_runs(id),
  drop_reason text,
  confidence_score numeric(3,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Rules (per-supplier, per-org, agent-global). Most-specific scope wins.
create table if not exists public.agent_rules (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents(id) on delete cascade,
  scope_type text not null check (scope_type in ('global','org','supplier','material')),
  scope_id text,                         -- nullable for global
  rule_type text not null check (rule_type in ('tone','language','sender_identity','cadence','channel','do_not_contact','custom')),
  rule_value jsonb not null,
  active boolean not null default true,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);
create index if not exists agent_rules_lookup_idx on public.agent_rules(agent_id, scope_type, scope_id, rule_type) where active;

-- Lead Scanner export queue (Andrew handoff via Slack).
create table if not exists public.lead_scanner_exports (
  id uuid primary key default gen_random_uuid(),
  supplier_name text,
  supplier_id text,
  csv_payload text,                      -- inline for small batches
  blob_ref text,                         -- supabase storage path for larger
  generated_at timestamptz not null default now(),
  slack_message_ts text,
  status text not null default 'queued' check (status in ('queued','sent','acknowledged_by_andrew','uploaded','failed')),
  error text,
  generated_by_agent uuid references public.agents(id)
);

-- Read-only mirror populated when Andrew confirms upload.
create table if not exists public.lead_scanner_mirror (
  id uuid primary key default gen_random_uuid(),
  supplier_name text,
  material_name text,
  source text,
  origin_org_id uuid references public.orgs(id),
  raw jsonb,
  uploaded_at timestamptz not null default now()
);

-- Audit log.
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.users(id),
  actor_agent_id uuid references public.agents(id),
  action text not null,
  target_table text,
  target_id uuid,
  diff jsonb,
  at timestamptz not null default now()
);
create index if not exists audit_log_at_idx on public.audit_log(at desc);

-- ============================================================
-- Triggers — keep updated_at fresh
-- ============================================================
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at := now(); return new; end;
$$ language plpgsql;

do $$
declare t text;
begin
  for t in select unnest(array['users','orgs','agents','draft_references','cases','leads_in_flight']) loop
    execute format('drop trigger if exists trg_touch_%I on public.%I', t, t);
    execute format('create trigger trg_touch_%I before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end$$;

-- ============================================================
-- Helper: current user's roles
-- ============================================================
create or replace function public.has_role(target text) returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = target
  );
$$;

create or replace function public.has_any_role(targets text[]) returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = any(targets)
  );
$$;

create or replace function public.is_authenticated() returns boolean
language sql stable as $$ select auth.uid() is not null $$;
