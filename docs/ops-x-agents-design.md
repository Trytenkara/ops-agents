# Ops × Agents — Build Design

Status: in progress (branch `ops-x-agents-build`)
Last updated: 2026-06-11

This doc consolidates the ops-side agent features layered on top of the Operators
Dashboard (Linear PRO-45) and the Outreach Tracker (PRO-129). It is the build
reference for the six feature bullets from the "Ship Superagent for ops team"
push (PRO-141).

## The one constraint that shapes everything

`material_quotes` lives in **Tenkara prod, which the agent runtime can only READ**
(`tenkaraQuery`, `mcp_readonly` role; writes are refused at connect time). Agents
**never** write prices back into Tenkara. The established pattern — already used by
Agent 05 (`marketplace_check_findings`) and Agent 11 (lead CSV push) — is:

> **stage in OA → ops reviews/cleans in-dash → export CSV → ops bulk-uploads to Tenkara**

Every pricing feature below follows that pipeline. No auto-write-back.

## Feature map

| # | Feature | Status | Where it lives |
|---|---------|--------|----------------|
| 1 | Email integration | DONE (Agent 13 / inbox-context) | `agents/inbox-context` |
| 2 | Price Pulse (min/avg/max + client benchmark) | building | `lib/price-pulse.ts` |
| 3 | QA watchdog | building | `agents/qa-watchdog` |
| 4 | Client settings profiles | mostly built | `client_settings` / `client_profiles` |
| 5 | Attachment price parsing | building | `agents/email-scanner` (extend) |
| 6 | Material savings reports | building | `lib/savings-report.ts` |

Dependency chain: **#5 → #2 → #6**; #4 feeds #6's "their price"; #3 watches all.

## Price capture pipeline

Three sources of supplier prices, normalized into **one staging table**
(`staged_quotes`, migration 0025). Marketplace findings keep their own table
(`marketplace_check_findings`) since they are tied to an existing Tenkara quote
baseline; the new email/attachment captures land in `staged_quotes`.

1. **Marketplace (web)** — Agent 05 `price-recheck.ts` already pulls current public
   prices → `marketplace_check_findings`.
2. **Email reply body** — extend `email-scanner` to extract a price from a supplier
   reply → `staged_quotes` (`source = 'email_body'`).
3. **Attachment** — extend `email-scanner` to parse PDF/spreadsheet attachments
   (prices often arrive as files, not inline) → `staged_quotes` (`source = 'attachment'`).

All three normalize to a **per-unit price** (`price / case_size`, grouped by unit)
because raw per-case prices are not comparable across suppliers.

## Price Pulse (#2)

Per-material price statistics over the **live Tenkara `material_quotes` corpus**
(this is the body of quotes that fills up as ops uploads staged quotes):

- group by `(material_id, lower(unit_of_measurement))`
- normalize `unit_price = price / nullif(case_size, 0)`
- only current quotes (`replaced_quote_id is null`, `price > 0`, `case_size > 0`)
- report `min / avg / max / count / distinct supplier count`
- **client benchmark**: given an org, compare that client's current quote(s) for a
  material against the pulse min/avg/max → percentile / above-or-below-market flag.

Implemented as a read-only query in `lib/price-pulse.ts`. No new table required for
the pulse itself; `staged_quotes` is just the inbound pipeline that grows the corpus.

## Material savings reports (#6)

Per-material, per-client report:

- **their price** = the client's current quote (or the price in their client profile / `client_settings`).
- **best Tenkara price** = cheapest current `material_quotes.unit_price` for that material across all suppliers (from Price Pulse).
- **savings** = their price − best price (absolute + %), with the recommended supplier.

Surfaced in-dash and exportable as a client-facing report.

## QA watchdog (#3)

A data-integrity agent that checks that the other agents' inputs landed correctly:
email replies that were detected but never produced a staged quote, attachments that
failed to parse, staged quotes missing required fields, marketplace findings stuck in
`needs_review`, etc. Writes issues to an OA table (or Slack) for ops to action. It does
not fix data — it flags.

## Ops interaction model (PRO-45 / PRO-129)

The clear, repeatable surface ops uses for every agent is a **review grid**:

> agent stages rows → ops sees them (flagged `needs_review` first) → edits/approves
> inline → **one button exports the clean CSV** for Tenkara bulk upload.

Ops edits in a structured, validated grid — not freeform spreadsheet — mirroring the
existing `/work/review/marketplace` page. This is the consistent way ops "interacts
with agent workflows" that both Linear tickets are reaching for.
