-- Migration 0023 - Client Profile "rep sheet".
--
-- The profile must answer the questions suppliers typically ask about a client,
-- so an operator can represent them: years in business, products, address,
-- end use, volume, order timing, intended use (resale vs manufacturing), and
-- whether they can meet in person. Agent 12 fills what it can from web + Tenkara
-- and leaves the rest null for ops to complete; ops can edit any field.

alter table public.client_profiles add column if not exists rep_sheet jsonb not null default '{}'::jsonb;
