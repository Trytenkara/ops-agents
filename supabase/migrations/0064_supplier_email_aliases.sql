create table if not exists public.supplier_email_aliases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  email text not null,
  supplier_id text,
  thread_id text,
  draft_ref_id uuid references public.draft_references(id) on delete set null,
  claim_status text not null default 'attached' check (claim_status in ('reserved', 'attached')),
  reservation_id uuid,
  supplier_name text,
  added_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  check (email = lower(trim(email)))
);

create unique index if not exists supplier_email_aliases_org_email_idx
  on public.supplier_email_aliases (org_id, email);
create index if not exists supplier_email_aliases_org_supplier_idx
  on public.supplier_email_aliases (org_id, supplier_id);
create index if not exists supplier_email_aliases_org_thread_idx
  on public.supplier_email_aliases (org_id, thread_id);

create or replace function public.reserve_supplier_emails(
  p_org_id uuid,
  p_emails text[],
  p_reservation_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer;
begin
  if p_org_id is null or p_reservation_id is null then
    raise exception 'reservation_identity_required';
  end if;
  select count(*) into v_expected
  from (select distinct lower(trim(email)) value from unnest(p_emails) email where trim(email) <> '') normalized;
  if v_expected = 0 then raise exception 'reservation_emails_required'; end if;
  insert into public.supplier_email_aliases (org_id, email, thread_id, claim_status, reservation_id)
  select p_org_id, value, null, 'reserved', p_reservation_id
  from (select distinct lower(trim(email)) value from unnest(p_emails) email where trim(email) <> '') normalized;
  return true;
exception
  when unique_violation then
    return false;
end;
$$;

create or replace function public.release_supplier_email_reservation(p_org_id uuid, p_reservation_id uuid) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  delete from public.supplier_email_aliases where org_id = p_org_id and reservation_id = p_reservation_id and claim_status = 'reserved';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.reserve_supplier_emails(uuid, text[], uuid) from public, anon, authenticated;
revoke all on function public.release_supplier_email_reservation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_supplier_emails(uuid, text[], uuid) to service_role;
grant execute on function public.release_supplier_email_reservation(uuid, uuid) to service_role;

alter table public.supplier_email_aliases enable row level security;
revoke all on table public.supplier_email_aliases from anon, authenticated;
