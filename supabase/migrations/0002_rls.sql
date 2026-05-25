-- Row-Level Security policies.
-- Posture: deny by default, allow read for any authenticated user across ops tables,
-- agent-tab tables only readable by monitor/admin. Writes happen via service-role
-- (server actions / agent API) and bypass RLS by design.

alter table public.users enable row level security;
alter table public.user_roles enable row level security;
alter table public.orgs enable row level security;
alter table public.org_default_operators enable row level security;
alter table public.agents enable row level security;
alter table public.agent_runs enable row level security;
alter table public.draft_references enable row level security;
alter table public.cases enable row level security;
alter table public.pending_approvals enable row level security;
alter table public.escalations enable row level security;
alter table public.leads_in_flight enable row level security;
alter table public.agent_rules enable row level security;
alter table public.lead_scanner_exports enable row level security;
alter table public.lead_scanner_mirror enable row level security;
alter table public.audit_log enable row level security;

-- self-read on users
drop policy if exists users_self_read on public.users;
create policy users_self_read on public.users for select to authenticated using (id = auth.uid() or public.has_any_role(array['admin','ops_lead','monitor']));

drop policy if exists user_roles_read on public.user_roles;
create policy user_roles_read on public.user_roles for select to authenticated using (user_id = auth.uid() or public.has_any_role(array['admin','ops_lead','monitor']));

-- orgs visible to all authenticated
drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs for select to authenticated using (true);

drop policy if exists org_default_operators_read on public.org_default_operators;
create policy org_default_operators_read on public.org_default_operators for select to authenticated using (true);

-- Ops-side tables visible to all authenticated
drop policy if exists draft_refs_read on public.draft_references;
create policy draft_refs_read on public.draft_references for select to authenticated using (true);

drop policy if exists cases_read on public.cases;
create policy cases_read on public.cases for select to authenticated using (true);

drop policy if exists approvals_read on public.pending_approvals;
create policy approvals_read on public.pending_approvals for select to authenticated using (true);

drop policy if exists escalations_read on public.escalations;
create policy escalations_read on public.escalations for select to authenticated using (true);

drop policy if exists leads_read on public.leads_in_flight;
create policy leads_read on public.leads_in_flight for select to authenticated using (true);

drop policy if exists lead_mirror_read on public.lead_scanner_mirror;
create policy lead_mirror_read on public.lead_scanner_mirror for select to authenticated using (true);

drop policy if exists agent_rules_read on public.agent_rules;
create policy agent_rules_read on public.agent_rules for select to authenticated using (true);

-- Agent-tab tables — monitor + admin only
drop policy if exists agents_read on public.agents;
create policy agents_read on public.agents for select to authenticated using (public.has_any_role(array['admin','monitor']));

drop policy if exists agent_runs_read on public.agent_runs;
create policy agent_runs_read on public.agent_runs for select to authenticated using (public.has_any_role(array['admin','monitor']));

drop policy if exists lead_exports_read on public.lead_scanner_exports;
create policy lead_exports_read on public.lead_scanner_exports for select to authenticated using (public.has_any_role(array['admin','monitor']));

drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (public.has_any_role(array['admin','monitor']));

-- self profile update (OOO toggle)
drop policy if exists users_self_update on public.users;
create policy users_self_update on public.users for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Mark draft reviewed (ops_operator/ops_lead/admin can update assigned-to-anyone drafts)
drop policy if exists draft_refs_update on public.draft_references;
create policy draft_refs_update on public.draft_references for update to authenticated
  using (public.has_any_role(array['admin','ops_lead','ops_operator']))
  with check (public.has_any_role(array['admin','ops_lead','ops_operator']));

-- Flip stamp-of-approval and edit agent config (admin or monitor)
drop policy if exists agents_update on public.agents;
create policy agents_update on public.agents for update to authenticated
  using (public.has_any_role(array['admin','monitor']))
  with check (public.has_any_role(array['admin','monitor']));
