# Marketplace pricing

Prices read off shop listings, and the delivery-cost capture that rides on the
same pull. These rules were written 2026-08-19 alongside the Agent 19 delivery
cost work; the file was lost in a mis-scoped commit (7624845 claimed it and did
not contain it) and reconstructed 2026-08-19 from that commit message and the
incident notes. The dangling PRICING-04 references in OUTSTANDING.md date from
the original writing.

## PRICING-01 — A shipping cost is a number or it is nothing

A delivery cost captured off a listing is stored as a numeric amount with a
currency, never as copied prose ("varies by location", a shipping-policy
sentence). A page that only offers prose has no readable cost: store null and
a failure reason.

Written because static text stored in a cost field reads as data downstream
and cannot be added to a landed price.

**Enforcement:** Check owed — `shipping/cost-must-be-numeric`.

## PRICING-02 — Delivery cost is per pack tier when pack size changes it

When a listing's pack rungs ship differently, the cost is recorded per tier.
One number smeared across all rungs makes the small pack look expensive to
land and the bulk pack look free.

**Enforcement:** Check owed — `shipping/cost-per-tier`.

## PRICING-03 — Delivery-cost extraction is opt-in per client

The pull attempts delivery costs only for clients that turned it on, using
that client's ship-to destination. No destination configured means no attempt
and no cost, not an attempt against a guessed address.

**Enforcement:** Guard — `shipping/ship-to-from-one-table`. The destination is
read through one accessor over `client_tenkara_settings`, and a client with no
usable address returns null so the pull declines to attempt. The checkout
formatter used to answer a missing destination with a hard-coded Los Angeles
address; a cost quoted to that is a real number for the wrong place, which is
the fabrication PRICING-05 forbids. It returns null now.

## PRICING-04 — Delivery-cost extraction is audited every run

Every run reports attempted versus captured, and a daily job alarms when the
capture rate collapses. Counters that nobody reads are not an audit: the
feature shipped inert (reading ship-to fields from the wrong table, so it
never produced a number) and nothing surfaced that for weeks, which is the
incident this rule exists to prevent.

**Enforcement:** Audit — Agent 26 counts four things daily and reports the gap
between them: listings pulled, rows carrying the delivery-cost keys, attempts
made, and numbers captured. The distinction matters more than the rate. A key
present with a null under it says the writer ran; a number says it produced
something; zero attempts against thousands of pulls says the feature is inert,
which is exactly the state it shipped in and held for weeks. The audit reports
the inert case as its own finding rather than as a capture rate of zero. Guard —
`shipping/ship-to-from-one-table` holds the cause. `getOrgShipToAddress` was
selecting `ship_to_*` columns that do not exist on this project's `orgs` table;
PostgREST answers that with an error, the catch swallowed it, and every caller
read the null as "this client has no ship-to" — zero attempts against 4,044
pulled listings, reported as a capture rate of null, which reads the same as a
quiet day. The addresses live on `client_tenkara_settings`, mirrored hourly by
Agent 12. The escalation run now counts priced leads with no destination
separately and names them in its summary, so the inert case cannot hide behind
a percentage again.

## PRICING-05 — A delivery cost is never fabricated

No guessed density, no assumed weight, no model estimate stored as if it had
been read off the page. Unreadable means null plus
`shipping_cost_failed_reason`, exactly as DATA-01 requires for prices. An
estimate may exist only as a clearly separate figure that can never be
mistaken for a captured cost. Known standing break: the per-tier estimator
assumes water density for solids, which DATA-07 forbids.

**Enforcement:** Check owed — `shipping/no-fabricated-costs`.

## PRICING-06 — The primary price pull runs on the fleet's own platform

The daily marketplace pull (Agent 05) and its browser escalation (Agent 19)
run on Vercel with the rest of the fleet. Neither may be moved to a local
container: the interim container crons are retired, and the container-side
skill exists for manual, interactive runs only. Nothing in the price cascade
may depend on a machine that is not the deployed fleet.

**Enforcement:** Judgement.

## PRICING-07 — A marketplace that deals by email becomes a second, direct supplier

When a marketplace or aggregator storefront replies from its own address rather
than the platform's, it has told us two separate things: the listing still
exists, and the company behind it will deal with us directly. Both are kept.
The marketplace lead stays exactly as it is, because the price index publishes
from it, and a second non-marketplace lead is stood up for the same supplier and
material, with its own quotes and its own comms.

Flipping the original lead in place is forbidden. It destroyed the listing the
index published from and left the direct relationship carrying marketplace
provenance, which is the incident this rule comes from.

The two versions are not duplicates and are never merged (DATA-12). They price
differently, and by the assignment rules they usually carry different operators.

**Enforcement:** Guard — `splitDirectLeadFromMarketplace` in
`src/lib/marketplace-direct-split.ts`, which refuses a platform address, refuses
a lead already split, and reuses an existing direct sibling instead of stacking
a second one.

## PRICING-08 — A price row belongs to one lane and no writer may cross

Every stored price says which lane it came from, and a writer for one lane may
only touch rows of that lane. A price read off a website may never take over,
relabel or restate a row that came from a supplier's email, and the reverse is
equally forbidden.

This is the other half of PRICING-07. The split gives the direct version the
same supplier name and the same supplier id on purpose, so any store that keys
on supplier plus material alone puts both lanes in one bucket and lets one lane
claim the other's row. A note in a text field is not a lane: it is a label one
writer happens to set and the other does not.

**Enforcement:** Guard — `quote_profiles.lane`, not null, no default at the
call site: `insertQuoteProfile` requires it, `seedQuoteProfilesFromStaged` reads
and writes `direct` only, `syncQuoteProfilesFromMarketplace` reads and writes
`marketplace` only, and the quotes tab groups by supplier and lane.
