alter table public.supplier_profiles
  add column if not exists generated_notes text;

alter table public.quote_profiles
  add column if not exists generated_notes text;

comment on column public.supplier_profiles.generated_notes is
  'Read-only summary generated from captured supplier evidence. Operator notes remain separate.';
comment on column public.quote_profiles.generated_notes is
  'Read-only summary generated from captured quote evidence. Operator notes remain separate.';

create or replace function public.protect_generated_notes() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.generated_notes is not null
     and (tg_op = 'INSERT' or new.generated_notes is distinct from old.generated_notes)
     and auth.role() is distinct from 'service_role'
     and current_user not in ('postgres', 'service_role') then
    raise exception 'generated_notes_read_only';
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_profiles_protect_generated_notes on public.supplier_profiles;
create trigger supplier_profiles_protect_generated_notes
  before insert or update on public.supplier_profiles
  for each row execute function public.protect_generated_notes();

drop trigger if exists quote_profiles_protect_generated_notes on public.quote_profiles;
create trigger quote_profiles_protect_generated_notes
  before insert or update on public.quote_profiles
  for each row execute function public.protect_generated_notes();
