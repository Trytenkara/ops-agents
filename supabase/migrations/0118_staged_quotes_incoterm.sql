-- Incoterm on staged supplier quotes.
--
-- Suppliers state price, incoterm and packing as three independent facts, and
-- until now only the price had a column: "FOB Anaheim", "EXW Xian", "CIF by sea"
-- were landing in free-text extraction_notes, where nothing can compare them.
-- Two prices are not comparable without the delivery term behind them, so the
-- term gets its own column and the named place gets its own alongside it.
--
-- Both stay null when the supplier never states a term. Never inferred: an
-- assumed EXW on a price that was actually CIF understates landed cost.

alter table public.staged_quotes
  add column if not exists incoterm text,
  add column if not exists incoterm_location text;

comment on column public.staged_quotes.incoterm is
  'Supplier-stated delivery term as an Incoterms code (EXW, FOB, CIF, CFR, DDP, ...). Null when unstated; never inferred.';
comment on column public.staged_quotes.incoterm_location is
  'The named place attached to the incoterm ("Shanghai", "Anaheim, CA"). Null when the supplier gave a bare term.';
