# Discovery

## DISC-01 — Search the trade's name, not ours

Every discovery source searches the material's trade names as well as the
client's intake-form string. Catalogues rarely use our wording: one material
sat at a clean zero from all three sources for four days while three
marketplaces carried it under two other names.

The resolver is `src/lib/material-aliases.ts`, model-resolved and cached per
material. Any new source must use it rather than resolving its own.

**Enforcement:** Guard — shared resolver, threaded into all three sources.
Owed: nothing forces a NEW source to call it.

## DISC-02 — Aliases must reach the relevance filter too

A source that searches aliases but filters results against the original string
discards the very rows the alias search just won.

**Enforcement:** Honour.

## DISC-03 — Aliases never re-specify (see DATA-09)

## DISC-04 — Zero is not empty (see PERS-03)

## DISC-05 — A platform is never the supplier

An aggregator or marketplace storefront is a route to a supplier, not the
supplier. It is never recorded as the manufacturer, and its domain is never
treated as a supplier's own domain for contact purposes.

This is a classification rule. It is NOT a reason to drop the lead: see
OUT-02.

**Enforcement:** Honour.

## DISC-06 — Duplicate suppliers have one definition

One shared module decides whether two rows are the same supplier. Discovery
resolves the supplier id at ingest rather than leaving it null for a later
name-match to guess at.

**Enforcement:** Guard — `src/lib/lead-dupe-guard.ts`.

## DISC-07 — Same name, different grade, is not a duplicate

Two materials that share a name but differ in grade are intentionally distinct
and must never be merged.

**Enforcement:** Honour.

## DISC-08 — A source's own paging must advance

A page cursor that resets every run re-reads page one forever: it burns credits
and returns the same suppliers. Every paged source stores and advances its
cursor, and the marker it writes must be the marker it reads.

**Enforcement:** Honour. A credit gate once wrote its marker under one key and
read it under another, so it never fired and the source re-ran every pass.

## DISC-09 — A self-supplied material is not sourced

Where a client makes the material themselves, discovery does not run for it.

**Enforcement:** Honour, currently several fail-open gates.
