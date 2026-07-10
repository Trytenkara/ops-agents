-- Migration 0040 - staged_quotes.grade
--
-- Capture a supplier-stated material grade alongside the price when it appears
-- in an inbound reply (e.g. "USP", "Food grade", "SCI 80"). This is ops context
-- for the Control Room review surfaces (Materials quote list, Live Price Index,
-- Leads); it is NOT emitted into the Tenkara quote CSV, because grade is a
-- material-level attribute in Tenkara, not a material_quotes column.
--
-- Only ever populated from what the supplier actually writes — never guessed.

alter table public.staged_quotes
  add column if not exists grade text;
