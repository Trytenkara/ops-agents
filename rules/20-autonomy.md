# Autonomy: decide, escalate, or never touch

The boundary is by consequence, not by topic.

## AUTO-01 — Decide alone: anything reversible inside the pipeline

A live run makes its own judgement calls and keeps going. Search terms, which
alias to try, which source to fall back to, how many pages to read, whether a
row is relevant. Never pause a run to ask.

**Enforcement:** Honour.

## AUTO-02 — Decide alone: volume of change

A client, material or grade change re-judges existing leads, not only future
ones. Large change counts are expected. Do not ask permission for the volume.

**Enforcement:** Guard — `src/lib/requirements-recheck.ts` `recheckOrgLeads`.

## AUTO-03 — Escalate: a real tradeoff, not a guess about one

Raise it when completeness genuinely costs something measurable (spend, runtime
that breaks a schedule, credits). Do not quietly pick the cheap option and call
it a decision. "It might get slow" is not a tradeoff, it is a guess; make it
complete and measure.

**Enforcement:** Honour.

## AUTO-04 — Escalate: anything irreversible or outside the pipeline

Destructive operations, spending real credits at a new order of magnitude,
sending anything to a supplier or client, changing infrastructure, changing
another person's access.

**Enforcement:** Honour.

## AUTO-05 — Never touch: operator and org membership

Never add, remove or re-type an operator, and never change org membership, to
close a gap or make an assignment work. Report the gap and stop. An oddity
that conforms to the rules is left alone even if it looks wrong.

**Enforcement:** Honour.

## AUTO-06 — Cold outbound is never auto-sent

Everything stages as a draft that a human reviews. This is the assumption that
makes several other rules safe (notably CONTACT-03, pattern-guessed
recipients).

**Enforcement:** Honour, plus the `COLD_OUTBOUND` flag.

## AUTO-07 — Owner of an open record is derived, never trusted

Every read surface derives who owns an open draft or case from one helper
rather than reading a stamp. Four places once rebuilt the same key and only
three agreed.

**Enforcement:** Guard — `src/lib/operator-assignment.ts` `recordOwnerId`,
`assignment/derive-owner-via-recordOwnerId`.

## AUTO-08 — Call tasks belong to call operators only

A call-task notification names both the call operator and the email operator so
both have context, but only the call operator is ever assigned as owner. With
no call operator available the task is unassigned; it never falls back to the
email operator.

**Enforcement:** Honour, partially held by the operator-type pool filter.

## AUTO-09 — Real clients before internal test orgs

When a shared capped queue serves both, organisations with `is_internal = false`
drain first every run. Internal test orgs get leftover capacity only.

**Enforcement:** Guard — `src/lib/org-priority.ts`,
`queues/no-inline-org-priority`.
