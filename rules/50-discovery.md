# Discovery

## DISC-01 — Search the trade's name, not ours

Every discovery source searches the material's trade names as well as the
client's intake-form string. Catalogues rarely use our wording: one material
sat at a clean zero from all three sources for four days while three
marketplaces carried it under two other names.

The resolver is `src/lib/material-aliases.ts`, model-resolved and cached per
material. Any new source must use it rather than resolving its own.

**Enforcement:** Guard — `discovery/source-must-use-alias-resolver`. Keyed on
the write, not on a list of the sources we have: anything under
`agents/lead-creator/` that inserts into `leads_in_flight` is a discovery
source by definition, and has to name the aliases. A new source cannot skip it
by not being on the list, because there is no list.

## DISC-02 — Aliases must reach the relevance filter too

A source that searches aliases but filters results against the original string
discards the very rows the alias search just won.

**Enforcement:** Guard — `discovery/relevance-filter-must-accept-aliases`,
anchored per filtering source, so deleting or renaming one is the violation
rather than a quiet loss of coverage.

## DISC-03 — Aliases never re-specify (see DATA-09)

**Enforcement:** Guard — see DATA-09.

## DISC-04 — Zero is not empty (see PERS-03)

**Enforcement:** See PERS-03.

## DISC-05 — A platform is never the supplier

An aggregator or marketplace storefront is a route to a supplier, not the
supplier. It is never recorded as the manufacturer, and its domain is never
treated as a supplier's own domain for contact purposes.

This is a classification rule. It is NOT a reason to drop the lead: see
OUT-02.

**Enforcement:** Guard — `discovery/platform-is-never-manufacturer`, four
mutations. Both halves, because only the first was ever held: the scout refuses
to stage a platform's own name as a company, and `stageDraft` refuses a
recipient at a platform's own domain unless the platform is itself the company
being written to. Both tests live in `src/lib/aggregator-hosts.ts`
(`isAggregatorPlatformName`, `isPlatformOwnedContact`). The gate sits at the
send rather than at each write because eighteen places stamp a contact email on
a lead and one place sends to it.

## DISC-06 — Duplicate suppliers have one definition

One shared module decides whether two rows are the same supplier. Discovery
resolves the supplier id at ingest rather than leaving it null for a later
name-match to guess at.

**Enforcement:** Guard — `src/lib/lead-dupe-guard.ts`.

## DISC-07 — Same name, different grade, is not a duplicate

Two materials that share a name but differ in grade are intentionally distinct
and must never be merged.

**Enforcement:** Guard — `materials/never-merge-on-name-alone`. It asserts the
grade test runs in the same loop as the name match, so a pair cannot reach the
candidate list on the name alone, and that nothing outside
`src/lib/material-merge-flags.ts` writes `material_merge_flags` (META-04).

## DISC-08 — A source's own paging must advance

A page cursor that resets every run re-reads page one forever: it burns credits
and returns the same suppliers. Every paged source stores and advances its
cursor, and the marker it writes must be the marker it reads.

A marker is only an answer in the shape the reader understands. One it cannot
read is not a finished pass, and must not be treated as one.

**Enforcement:** Guard — `discovery/marker-shape-must-fail-closed`: the credit
gate reads `done === true`, so an unrecognised marker means not finished, and
the writer must emit the key the reader looks for. Plus Audit — Agent 26 reads
the discovery agent's stored state daily and reports both shapes of the fault:
a credit-gate marker saved without `done`, and a page cursor nobody writes any
more.

The reader used to default a missing `done` to finished. All 15 SourceReady
markers predated the field, so each read as finished and gated its material off
SourceReady permanently, for having been searched once. Repaired 2026-08-22:
the 15 markers were rewritten with `done: false` and the 52 orphaned cursors —
written by nobody, and only ever looked up under an `importyeti:` key — were
deleted, both backed up first.

## DISC-09 — A self-supplied material is not sourced

Where a client makes the material themselves, discovery does not run for it.

Five paths ask the question — discovery, enrichment, outreach, the price pull
and the lead ingest route — and the answer has three states, not two: the
client makes it, the client does not, and we could not ask. A path that cannot
ask stops. It does not proceed on the assumption that nothing is self-supplied,
because that is the one assumption that sources all of it.

**Enforcement:** Guard — `discovery/self-supplied-gate-must-fail-closed`,
twelve mutations. `loadSelfSuppliedMaterials` returns whether it knows, and
each of the five callers is checked both for asking and for handling the answer
it may not get.

## DISC-10 — Checkout decides what a marketplace is

A page where you can actually check out and buy is a marketplace. A page that
shows a price with no way to buy is a listing, and a listing is not a
marketplace, whatever the domain's reputation or a sign-in wall suggests.
Checkout availability is the primary classification signal; reputation and
`login_required` are secondary at best.

**Enforcement:** Guard — the price read downgrades any marketplace-labelled
page with no checkout at the single read chokepoint (`marketplace_checkout`
downgrade in `lead-price-pull.ts`), and the scout prompt applies the same
test at classification time.
