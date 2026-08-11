-- Adds a BREADTH check to sourcing_health_report.
--
-- Why: the existing `thin` check could never fire for the case it matters most.
-- It only considers materials with `raw_leads = 0` (see 0108 line "A material
-- with raw leads is still enriching: counted, never flagged"), so a newly-added
-- material — whose leads are all raw by definition — is exempt from the moment
-- it is created. Enrichment has run 400+ hours behind, so the exemption never
-- lifts. Observed 2026-08-10: California Chemicals' "Rapeseed Fatty Acid" sat at
-- 6-7 leads against a 100-lead target and the report returned `thin: []`.
-- Compounding it, `thin` triggers under 8 leads while the actual target is 100,
-- so a material stalled at 20 was invisible even once its leads settled.
--
-- The breadth check is deliberately independent of stage: it asks the only
-- question that matters to a buyer ("how many suppliers does this material
-- have?") and ignores where they are in the pipeline. An age gate keeps a
-- material that is legitimately still ramping from flagging on its first hours.
--
-- Signature change: the 4-arg form is DROPPED rather than left in place, because
-- `create or replace` with extra params creates an overload, and a PostgREST rpc
-- call naming the original 4 args would then match both and fail as ambiguous.

drop function if exists public.sourcing_health_report(text, int, numeric, int);

create or replace function public.sourcing_health_report(
  p_org text,
  p_min_leads int default 8,
  p_min_contact_frac numeric default 0.4,
  p_stale_hours int default 48,
  p_breadth_target int default 100,
  p_breadth_min_age_hours int default 12
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_dup_pairs int;
  v_stuck jsonb;
  v_thin jsonb;
  v_low_contact jsonb;
  v_in_progress int;
  v_raw_n int;
  v_raw_age_h numeric;
  v_undrafted int;
  v_breadth jsonb;
  v_breadth_n int;
  v_breadth_worst int;
begin
  -- 1. Duplicate loop: (material_id, supplier_id) pairs holding >1 active lead.
  -- Regression check for the agent-03 graph-dedup fix (PR #66).
  select count(*) into v_dup_pairs from (
    select l.material_id, l.supplier_id
    from leads_in_flight l join orgs o on o.id = l.org_id
    where o.name = p_org and l.status = 'active' and l.supplier_id is not null
    group by 1, 2 having count(*) > 1
  ) d;

  -- 2. Stuck agents: still 'running' after the lock TTL expired, i.e. an
  -- orphaned run the self-heal reaper has not reclaimed. Keyed off locked_until
  -- (set on claim, cleared on completion) and NOT last_run_at, which only bumps
  -- when a run finishes and so makes every healthy in-flight run look stale.
  select coalesce(jsonb_agg(jsonb_build_object('slug', slug, 'age_s', age_s)), '[]'::jsonb)
    into v_stuck
  from (
    select slug, extract(epoch from (now() - coalesce(locked_until, last_run_at)))::int as age_s
    from agents
    where status = 'running' and (locked_until is null or locked_until < now())
  ) s;

  -- 3+4. Per-material richness. Grouped by material_id, never material_name:
  -- scout leads can carry an empty or inconsistent name, which would split one
  -- material into several phantom rows and falsely flag it as thin.
  with per_material as (
    select l.material_id,
      max(nullif(l.material_name, '')) as name,
      count(*) as leads,
      count(*) filter (where l.stage = 'raw') as raw_leads,
      count(*) filter (where l.stage <> 'raw') as settled,
      count(*) filter (where l.stage <> 'raw'
        and (l.payload->'enrichment'->'email_check'->>'format_valid') = 'true') as valid_email,
      count(*) filter (where l.stage <> 'raw'
        and coalesce(l.payload->>'supplier_website',
                     l.payload->'enrichment'->'contact'->>'contact_url') is not null) as with_site
    from leads_in_flight l join orgs o on o.id = l.org_id
    where o.name = p_org and l.status = 'active'
    group by 1
  )
  select
    -- A material with raw leads is still enriching: counted, never flagged HERE.
    -- The breadth check below deliberately does not honour this exemption.
    count(*) filter (where raw_leads > 0),
    coalesce(jsonb_agg(jsonb_build_object(
        'name', coalesce(name, '(unnamed ' || left(material_id::text, 8) || ')'),
        'leads', leads))
      filter (where raw_leads = 0 and leads < p_min_leads), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
        'name', coalesce(name, '(unnamed ' || left(material_id::text, 8) || ')'),
        'settled', settled, 'valid_email', valid_email, 'with_site', with_site))
      filter (where raw_leads = 0 and leads >= p_min_leads and settled > 0
        and (greatest(valid_email, with_site)::numeric / settled) < p_min_contact_frac), '[]'::jsonb)
    into v_in_progress, v_thin, v_low_contact
  from per_material;

  -- 4b. BREADTH: materials that have not reached the supplier-count target,
  -- counted across every stage. Age is measured from the material's OLDEST
  -- active lead, which is the closest proxy for "when sourcing started" that
  -- this database holds. A material with zero leads never appears here at all —
  -- agent-03 reports those separately as its "empty:" list.
  with per_material as (
    select l.material_id,
      max(nullif(l.material_name, '')) as name,
      count(*) as leads,
      extract(epoch from (now() - min(l.created_at))) / 3600 as age_h
    from leads_in_flight l join orgs o on o.id = l.org_id
    where o.name = p_org and l.status = 'active'
    group by 1
  ), stalled as (
    select * from per_material
    where leads < p_breadth_target and age_h >= p_breadth_min_age_hours
  )
  select
    (select count(*) from stalled),
    (select min(leads) from stalled),
    -- Worst 10 only, by lead count ascending. The full size is reported
    -- alongside as breadth_stalled_count so the list is never mistaken for the
    -- whole set.
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', coalesce(t.name, '(unnamed ' || left(t.material_id::text, 8) || ')'),
               'leads', t.leads,
               'age_h', round(t.age_h::numeric, 1))
               order by t.leads asc)
      from (select * from stalled order by leads asc limit 10) t
    ), '[]'::jsonb)
    into v_breadth_n, v_breadth_worst, v_breadth;

  -- 5. Enrichment lag: how much raw work agent-06 is sitting on, and its age.
  select count(*), extract(epoch from (now() - min(l.created_at))) / 3600
    into v_raw_n, v_raw_age_h
  from leads_in_flight l join orgs o on o.id = l.org_id
  where o.name = p_org and l.stage = 'raw' and l.status = 'active';

  -- 6. Undrafted backlog: enriched, unheld, aged past the window, no draft.
  select count(*) into v_undrafted
  from leads_in_flight l join orgs o on o.id = l.org_id
  where o.name = p_org and l.stage = 'enriched' and l.status = 'active'
    and not (l.payload ? 'phased_hold') and not (l.payload ? 'outreach_hold')
    and l.created_at < now() - make_interval(hours => p_stale_hours)
    and not exists (
      select 1 from draft_references dr
      where dr.org_id = l.org_id and dr.supplier_id = l.supplier_id
        and dr.status in ('staged', 'reviewed', 'sent'));

  return jsonb_build_object(
    'org', p_org,
    'dup_pairs', v_dup_pairs,
    'stuck', v_stuck,
    'thin', v_thin,
    'low_contact', v_low_contact,
    'in_progress', v_in_progress,
    'breadth_stalled', v_breadth,
    'breadth_stalled_count', coalesce(v_breadth_n, 0),
    'breadth_worst_leads', v_breadth_worst,
    'raw_pending', coalesce(v_raw_n, 0),
    'raw_oldest_hours', v_raw_age_h,
    'undrafted', v_undrafted,
    'thresholds', jsonb_build_object(
      'min_leads', p_min_leads,
      'min_contact_frac', p_min_contact_frac,
      'stale_hours', p_stale_hours,
      'breadth_target', p_breadth_target,
      'breadth_min_age_hours', p_breadth_min_age_hours)
  );
end;
$$;

comment on function public.sourcing_health_report(text, int, numeric, int, int, int) is
  'Read-only sourcing pipeline health checks for one org. Backs agent-16-sourcing-health.';
