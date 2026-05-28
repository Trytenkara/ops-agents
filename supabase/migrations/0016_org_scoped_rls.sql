-- Tighten RLS on org-scoped tables so reads can't leak across orgs even when
-- a future page forgets to filter by org_id. Scope: any authenticated user
-- with admin/ops_lead/monitor sees everything; everyone else only sees rows
-- whose org_id is in their user_org_assignments. Service-role writes still
-- bypass RLS as before (server actions, agent runtime).
--
-- Tables covered: leads_in_flight, draft_references, pending_approvals,
-- cases, escalations. Other tables (agents, agent_runs, lead_scanner_*)
-- already gate by has_any_role(['admin','monitor']) which is correct.

-- Helper: does the current user have access to <org_id> via assignment?
-- Defined here so policies stay tidy. security definer because RLS on
-- user_org_assignments would otherwise hide other-user rows from a self-read.
create or replace function public.user_has_org_access(target_org uuid)
returns boolean
language sql stable security definer as $$
  select target_org is not null and exists (
    select 1 from public.user_org_assignments
    where user_id = auth.uid() and org_id = target_org
  );
$$;

-- leads_in_flight: org-scoped read for non-leads. Rows with null org_id
-- (cross-org raw leads) stay visible only to admin/ops_lead/monitor.
drop policy if exists leads_read on public.leads_in_flight;
create policy leads_read on public.leads_in_flight for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );

-- draft_references: same gating, plus operators can always see drafts
-- assigned directly to them (Today/Inbox surfaces these by assigned_operator,
-- not by org).
drop policy if exists draft_refs_read on public.draft_references;
create policy draft_refs_read on public.draft_references for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
    or assigned_operator = auth.uid()
  );

-- pending_approvals: always has a non-null org_id per the schema check.
drop policy if exists approvals_read on public.pending_approvals;
create policy approvals_read on public.pending_approvals for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );

-- cases: org_id is NOT NULL in the schema. Add account_manager access via
-- assignment.
drop policy if exists cases_read on public.cases;
create policy cases_read on public.cases for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );

-- escalations: similar shape; org_id may be null in legacy rows.
drop policy if exists escalations_read on public.escalations;
create policy escalations_read on public.escalations for select to authenticated
  using (
    public.has_any_role(array['admin','ops_lead','monitor'])
    or public.user_has_org_access(org_id)
  );

-- Tighten existing UPDATE policy on draft_references so an operator can only
-- flip status on drafts they actually have access to. Reviewer set still
-- happens via service-role in markDraftReviewed, but defense-in-depth.
drop policy if exists draft_refs_update on public.draft_references;
create policy draft_refs_update on public.draft_references for update to authenticated
  using (
    public.has_any_role(array['admin','ops_lead'])
    or (public.has_any_role(array['ops_operator']) and (
      public.user_has_org_access(org_id) or assigned_operator = auth.uid()
    ))
  )
  with check (
    public.has_any_role(array['admin','ops_lead'])
    or (public.has_any_role(array['ops_operator']) and (
      public.user_has_org_access(org_id) or assigned_operator = auth.uid()
    ))
  );
