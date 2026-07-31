alter table public.draft_references
  drop constraint if exists draft_references_status_check;

alter table public.draft_references
  add constraint draft_references_status_check
  check (status in ('staged', 'reviewed', 'sent', 'discarded', 'superseded', 'blocked', 'linked'));

create unique index if not exists draft_references_manual_link_idx
  on public.draft_references (org_id, thread_id, (metadata->>'linked_lead_id'))
  where status = 'linked' and metadata->>'linked_lead_id' is not null;

create or replace function public.link_lead_conversation(
  p_lead_id uuid,
  p_conversation_id text,
  p_actor_id uuid,
  p_subject text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.leads_in_flight%rowtype;
  v_ref_id uuid;
  v_payload jsonb;
begin
  select * into v_lead from public.leads_in_flight where id = p_lead_id for update;
  if not found then raise exception 'lead_not_found'; end if;
  if v_lead.status <> 'active' then raise exception 'lead_not_active'; end if;
  if coalesce(v_lead.payload->'outreach'->>'conversation_id', '') <> ''
     or coalesce(v_lead.payload->'outreach'->>'draft_id', '') <> '' then
    raise exception 'lead_already_has_outreach';
  end if;

  insert into public.draft_references (
    email_client, thread_id, draft_id, org_id, supplier_id, material_id,
    status, subject, metadata
  ) values (
    'rod_app', p_conversation_id, 'manual:' || p_lead_id::text,
    v_lead.org_id, v_lead.supplier_id, v_lead.material_id, 'linked', p_subject,
    jsonb_build_object(
      'draft_kind', 'manual_conversation_link',
      'link_source', 'manual',
      'linked_lead_id', v_lead.id,
      'supplier_name', v_lead.supplier_name,
      'material_name', v_lead.material_name,
      'linked_by', p_actor_id,
      'linked_at', now()
    )
  )
  on conflict (org_id, thread_id, (metadata->>'linked_lead_id'))
    where status = 'linked' and metadata->>'linked_lead_id' is not null
  do update set subject = excluded.subject
  returning id into v_ref_id;

  v_payload := coalesce(v_lead.payload, '{}'::jsonb);
  v_payload := jsonb_set(
    v_payload,
    '{outreach}',
    coalesce(v_payload->'outreach', '{}'::jsonb) || jsonb_build_object(
      'email_client', 'rod_app',
      'conversation_id', p_conversation_id,
      'link_source', 'manual',
      'linked_by', p_actor_id,
      'linked_at', now()
    ),
    true
  );
  update public.leads_in_flight set payload = v_payload where id = v_lead.id;
  return v_ref_id;
end;
$$;

revoke all on function public.link_lead_conversation(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.link_lead_conversation(uuid, text, uuid, text) to service_role;
