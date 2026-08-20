# Autonomy: decide, escalate, or never touch

The boundary is by consequence, not by topic.

## AUTO-01 — Decide alone: anything reversible inside the pipeline

A live run makes its own judgement calls and keeps going. Search terms, which
alias to try, which source to fall back to, how many pages to read, whether a
row is relevant. Never pause a run to ask.

**Enforcement:** Judgement.

## AUTO-02 — Decide alone: volume of change

A client, material or grade change re-judges existing leads, not only future
ones. Large change counts are expected. Do not ask permission for the volume.

**Enforcement:** Guard — `src/lib/requirements-recheck.ts` `recheckOrgLeads`.

## AUTO-03 — Escalate: a real tradeoff, not a guess about one

Raise it when completeness genuinely costs something measurable (spend, runtime
that breaks a schedule, credits). Do not quietly pick the cheap option and call
it a decision. "It might get slow" is not a tradeoff, it is a guess; make it
complete and measure.

**Enforcement:** Judgement.

## AUTO-04 — Escalate: anything irreversible or outside the pipeline

Destructive operations, spending real credits at a new order of magnitude,
sending anything to a supplier or client, changing infrastructure, changing
another person's access.

**Enforcement:** Judgement.

## AUTO-05 — Never touch: operator and org membership

Never add, remove or re-type an operator, and never change org membership, to
close a gap or make an assignment work. Report the gap and stop. An oddity
that conforms to the rules is left alone even if it looks wrong.

**Enforcement:** Check owed — `orgs/no-operator-membership-writes`: no code
path inserts, deletes or retypes an operator or an org membership.

## AUTO-06 — Cold outbound is never auto-sent

Everything stages as a draft that a human reviews. This is the assumption that
makes several other rules safe (notably CONTACT-03, pattern-guessed
recipients).

**Enforcement:** Check owed — `outreach/no-send-outside-operator-action`,
plus the existing `COLD_OUTBOUND` flag.

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

**Enforcement:** Check owed — `assignment/call-owner-must-be-call-operator`.
Partially held today by the operator-type pool filter.

## AUTO-09 — Real clients before internal test orgs

When a shared capped queue serves both, organisations with `is_internal = false`
drain first every run. Internal test orgs get leftover capacity only.

**Enforcement:** Guard — `src/lib/org-priority.ts`,
`queues/no-inline-org-priority`.

## AUTO-10 — Near-duplicate supplier names reach one operator

Two spellings of one company ("Manoj Plastic" and "Manoj Plastics", "Elm Kimya
A.S." and "Elm Kimya A.Ş.") are one supplier to that supplier, so they are owned
by one operator within a client. Exact name matches already collapse; near
matches did not, and were split across two operators.

Grouping applies from the next sourcing exercise onward. A name whose rows
predate the cutoff keeps the owner it has: retrospective grouping would move
suppliers a client's operators are already working, which ops asked us not to
do.

**Enforcement:** Guard — `src/lib/operator-assignment.ts`
`mergeSimilarNameKeys`, applied inside `getOrgLeadIndex` so every surface that
resolves an owner shares one key map.

## AUTO-11 — The lead names the operator, every other surface follows

The lead assignment is the source of truth for who owns a supplier. Threads,
drafts, quotes, the Tenkara inbox and the Suppliers tab all show the operator
the lead names. Nothing else is allowed to reach its own answer.

In particular a Tenkara `supplier_id` is not an identity of its own. A lead
almost never carries one (it is resolved later, at first draft, and written onto
the conversation alone), so a surface that hashes on the id is hashing on
something the lead does not have, and names a different person: 759 of
California Chemicals' 2,208 threads and 197 of SaponIQ's 894 did exactly that.
The one exception is a supplier an operator claimed by hand, because claims are
recorded against the supplier id.

The direction is one-way. Aligning a surface means pulling it onto the lead's
answer, never moving a lead to match a thread.

The same holds for the LANE the owner is picked from, since operators are split
by lane. A supplier's kind is read off its name, which a validated profile
owns, before its key. The key is a contact email whenever the row carries no
supplier id, two unrelated suppliers can share one mailbox, and only leads write
an email-keyed kind, from the scanner's first guess. Reading the key first let
one supplier's guess pick another's lane, which is how 27 live drafts ended up
owned by an aggregator operator while their leads named someone else.

**Enforcement:** Guard — `src/lib/operator-assignment.ts` `orgAutoKey` resolves
every row through the key map built from the leads and profiles, `supplierKind`
resolves every lane name-first, and every derivation site goes through both.
