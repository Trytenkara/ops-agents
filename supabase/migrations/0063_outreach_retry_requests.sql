create or replace function public.mark_outreach_retry(
  p_lead_ids uuid[],
  p_request_id uuid,
  p_actor_id uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if coalesce(array_length(p_lead_ids, 1), 0) = 0 then
    raise exception 'no_retry_leads';
  end if;
  perform 1 from public.leads_in_flight where id = any(p_lead_ids) order by id for update;
  select count(*) into v_count
  from public.leads_in_flight
  where id = any(p_lead_ids) and status = 'active' and stage = 'enriched';
  if v_count <> array_length(p_lead_ids, 1) then
    raise exception 'retry_group_changed';
  end if;
  if exists (
    select 1 from public.leads_in_flight
    where id = any(p_lead_ids) and payload ? 'outreach_retry'
  ) then
    raise exception 'retry_already_requested';
  end if;
  update public.leads_in_flight
  set payload = jsonb_set(
    coalesce(payload, '{}'::jsonb),
    '{outreach_retry}',
    jsonb_build_object('request_id', p_request_id, 'requested_by', p_actor_id, 'requested_at', now()),
    true
  )
  where id = any(p_lead_ids);
  return v_count;
end;
$$;

create or replace function public.clear_outreach_retry(p_request_id uuid) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.leads_in_flight
  set payload = coalesce(payload, '{}'::jsonb) - 'outreach_retry'
  where payload->'outreach_retry'->>'request_id' = p_request_id::text;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.mark_outreach_retry(uuid[], uuid, uuid) from public, anon, authenticated;
revoke all on function public.clear_outreach_retry(uuid) from public, anon, authenticated;
grant execute on function public.mark_outreach_retry(uuid[], uuid, uuid) to service_role;
grant execute on function public.clear_outreach_retry(uuid) to service_role;
