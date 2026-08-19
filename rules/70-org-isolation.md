# Organisation isolation

One client's data may never appear under another client's name. This is the
rule with the worst failure mode in the system: two clients silently sharing
one conversation and one draft.

## ORG-01 — Every idempotency key is scoped to the organisation

The email platform returns the EXISTING conversation and draft for a repeated
external reference, so an unscoped reference silently hands one client's thread
to another. Never build a reference or a supplier grouping key by hand.

**Enforcement:** Guard — `src/lib/org-isolation.ts` `orgScopedExternalId`,
`orgScopedKey`, `foreignOrgRows`; `orgs/staging-must-scope-external-id` and
`orgs/conversation-create-must-scope-external-id`.

## ORG-02 — Never fold leads from two clients into one draft

Check before grouping, not after.

**Enforcement:** Guard — `foreignOrgRows`.

## ORG-03 — Shared natural keys carry the organisation in the database too

Any table whose natural key is an address, a URL or a domain is unique on that
key PLUS the organisation. Three tables were not, so the first client to touch
a supplier address or a document page blocked every other client from it.

The unique key and the conflict target must move together: a key naming the
organisation with a conflict target that does not will fail at runtime, and the
reverse silently overwrites another client's row.

**Enforcement:** Guard — `orgs/upsert-conflict-key-must-include-org` plus the
schema migrations.

## ORG-04 — An ambiguous inbound reply goes to triage, not to a guess

A supplier reply attaches to an existing outreach only when every candidate
draft belongs to ONE client. Where the receiving mailbox does not identify the
client, an ambiguous match is escalated rather than filed under whichever row
sorted first.

**Enforcement:** Guard — `soleOrgOwner`.

## ORG-05 — The live data is audited every morning

Guards only stop the mistakes we have already seen. A daily read-only audit
reports shared conversations, shared drafts, colliding reference keys, drafts
naming another client, and replies parked with no client. It is read-only on
purpose: deciding whose a contaminated record is needs a person, and a repair
loop that guessed would hide the fault.

Add a check there whenever you add a guard here.

**Enforcement:** Audit — the daily organisation-isolation audit.

## ORG-06 — Cross-client lookups are scoped at the query, not filtered after

A name search across a shared table returns other clients' rows unless the
query itself is scoped.

**Enforcement:** Honour. Owed guard, and an outstanding repair of the records
already mislabelled. See `OUTSTANDING.md`.

## ORG-07 — Unaudited edge

The inbox application is not in this repository, so the uniqueness scope of the
external reference, inbound reply matching, and thread merging are enforced
caller-side only and are not audited.

**Enforcement:** None. Known gap.
