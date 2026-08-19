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

**Enforcement:** Check owed — `orgs/name-lookup-must-scope-query`, plus an
outstanding repair of the records already mislabelled. See `OUTSTANDING.md`.

## ORG-08 — Membership in `organization_ids` tests the whole set, never a fixed slot

`organization_ids` is the set of every client that owns a shared row. Indexing a
fixed element (`organization_ids[1] = $1`) only matches rows where that client
happens to sort first, so a supplier owned by two clients is invisible to the
query. Agent 20's duplicate guard read the supplier list this way, so any
supplier already shared with a second client looked like it did not exist, and
the incoming lead was promoted as a brand-new duplicate of it — the exact thing
the guard exists to stop.

Test membership with `$n = any(organization_ids)` in SQL or `.includes(orgId)`
in TypeScript. A positional index is never a membership test.

**Enforcement:** Guard — `orgs/no-fixed-index-org-membership`.

## ORG-09 — A supplier shared across clients never suppresses a client-owned supplier

Suppliers are qualified and contacted independently for each client. A legacy
supplier row whose `organization_ids` contains more than one client is therefore
not evidence that the supplier already exists for either client's independent
pipeline. Duplicate prevention may compare a lead only with supplier rows whose
organisation set is exactly that lead's client.

For Agent 20 this means both `$1 = any(organization_ids)` and
`cardinality(organization_ids) = 1`. Membership alone is not ownership.

**Enforcement:** Guard — `orgs/duplicate-guard-requires-exclusive-supplier`.

## ORG-07 — Unaudited edge

The inbox application is not in this repository, so the uniqueness scope of the
external reference, inbound reply matching, and thread merging are enforced
caller-side only and are not audited.

**Enforcement:** None. Known gap.
