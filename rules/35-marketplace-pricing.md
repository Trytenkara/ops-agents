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

**Enforcement:** Check owed — `shipping/extraction-org-opt-in`.

## PRICING-04 — Delivery-cost extraction is audited every run

Every run reports attempted versus captured, and a daily job alarms when the
capture rate collapses. Counters that nobody reads are not an audit: the
feature shipped inert (reading ship-to fields from the wrong table, so it
never produced a number) and nothing surfaced that for weeks, which is the
incident this rule exists to prevent.

**Enforcement:** Audit owed — daily shipping-capture health job,
`shipping/health-must-monitor-extraction-rate`.

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
