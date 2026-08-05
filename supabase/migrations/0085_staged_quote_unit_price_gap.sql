-- Why unit_price is blank on a staged quote.
--
-- unit_price is generated from price / case_size, so it nulls out whenever the
-- extractor cannot tell what quantity the price applies to. Without a reason
-- recorded, an operator reading the review grid cannot distinguish "supplier
-- never said" from "extraction failed", and the previous behaviour was to guess
-- a basis instead (a packing line read as the price basis produced $116/kg
-- cumin from a $2,900 container quote). The reason string is what the review UI
-- shows on hover over the blank cell.
alter table staged_quotes
  add column if not exists unit_price_gap_reason text;

comment on column staged_quotes.unit_price_gap_reason is
  'Supplier-grounded explanation for a null unit_price (ambiguous price basis). Null when unit_price is populated.';
