-- Migration 0053 - staged_quotes case dimensions
--
-- Ops has to determine outer case dimensions (for freight rate calc on Tenkara)
-- for every priced quote, today by hand via a ChatGPT prompt. These columns let
-- us auto-populate that per staged quote and carry it straight into the
-- Tenkara-ready CSV. They mirror the real Tenkara material_quotes target 1:1:
--   material_quotes.case_type       text        (values: Box/Bag, Drum, Tote)
--   material_quotes.case_dimensions jsonb        {unit, width, height, length, packaging_case_weight}
-- so the export maps with no transformation.
--
-- dim_source records provenance: 'supplier' when the supplier stated the
-- dimensions, 'ai_estimated' when derived from standard industry sizing per the
-- case-dimension SOP. Ops trust-but-verify AI estimates before upload.
--
-- case_dimensions stores outer/shippable-unit dims in inches, weight in kg,
-- never pallet dims. See the case-dimensions skill for the sizing rules.

alter table public.staged_quotes
  add column if not exists case_type text,
  add column if not exists case_dimensions jsonb,
  add column if not exists dim_source text;
