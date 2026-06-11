-- Migration 0025 - staged_quotes
--
-- Unified staging table for supplier prices captured from email replies and
-- email attachments (Agent 08 / Email Scanner extensions). Marketplace web
-- prices keep their own table (marketplace_check_findings) because they are
-- tied to an existing Tenkara quote baseline; these rows are NEW quotes we
-- observed in an inbound email that do not yet exist in Tenkara.
--
-- Same pipeline as every other pricing surface: Tenkara is read-only, so these
-- rows are staged in OA, reviewed/cleaned by ops in-dash, then exported as a CSV
-- that ops bulk-uploads to Tenkara. No automatic write-back.
--
-- The captured price feeds Price Pulse (lib/price-pulse.ts) once ops has
-- uploaded it into material_quotes; until then it sits here as pending pipeline.

create table if not exists public.staged_quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete set null,
  run_id uuid references public.agent_runs(id) on delete set null,

  -- Where the price came from.
  source text not null check (source in ('email_body','attachment')),
  -- Provenance back to the email so ops can open the original.
  source_conversation_id text,
  source_message_id text,
  source_attachment_name text,
  source_attachment_url text,

  -- Tenkara identifiers when we could resolve them (read-only; stored, never
  -- written back). Null when the supplier/material is new or unresolved -
  -- ops fills these in during review before the CSV is usable.
  supplier_id uuid,
  supplier_name text,
  material_id uuid,
  material_name text,

  -- Pricing. Per-case price + case size; unit_price is the normalized
  -- per-unit figure Price Pulse compares on.
  price numeric(14,4),
  case_size numeric(14,4),
  unit_of_measurement text,
  currency text default 'USD',
  unit_price numeric(14,6)
    generated always as (
      case
        when price is null or case_size is null or case_size = 0 then null
        else price / case_size
      end
    ) stored,

  -- How confident the extractor was; low-confidence rows sort to the top of
  -- the review grid.
  confidence text not null default 'needs_review'
    check (confidence in ('high','medium','low','needs_review')),
  extraction_notes text,
  raw_extract jsonb default '{}'::jsonb,

  -- Review workflow - mirrors marketplace_check_findings.
  status text not null default 'pending_review'
    check (status in ('pending_review','approved','dismissed')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  dismissed_by uuid references auth.users(id) on delete set null,
  dismissed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists staged_quotes_org_status_idx
  on public.staged_quotes (org_id, status);
create index if not exists staged_quotes_material_idx
  on public.staged_quotes (material_id);
create index if not exists staged_quotes_supplier_idx
  on public.staged_quotes (supplier_id);
create index if not exists staged_quotes_run_idx
  on public.staged_quotes (run_id);
create index if not exists staged_quotes_conf_idx
  on public.staged_quotes (confidence);

-- updated_at trigger - reuse the shared helper.
do $$
begin
  drop trigger if exists trg_touch_staged_quotes on public.staged_quotes;
  create trigger trg_touch_staged_quotes before update on public.staged_quotes
    for each row execute function public.touch_updated_at();
end$$;

-- RLS: same shape as marketplace_check_findings. Admin/ops_lead/monitor see all;
-- ops_operator sees rows for orgs they're assigned to. Service role (agent
-- runtime) bypasses RLS so the scanner writes freely.
alter table public.staged_quotes enable row level security;

drop policy if exists staged_quotes_read on public.staged_quotes;
create policy staged_quotes_read on public.staged_quotes for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );

drop policy if exists staged_quotes_update on public.staged_quotes;
create policy staged_quotes_update on public.staged_quotes for update to authenticated
  using (
    public.has_any_role(array['admin','ops_lead'])
    or (public.has_any_role(array['ops_operator']) and public.user_has_org_access(org_id))
  )
  with check (
    public.has_any_role(array['admin','ops_lead'])
    or (public.has_any_role(array['ops_operator']) and public.user_has_org_access(org_id))
  );
