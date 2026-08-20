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

## ORG-10 — A supplier id is checked against its owners before it is stored

A supplier id is only ever stored on a client's row after that client is
confirmed to be in the supplier's `organization_ids`. If it is not, resolve the
client's own record of the same company by name; if they have none, store null.
Where there is no client to scope against, store null. An id is never stored
because the caller supplied one, or because it was already on a row we read.

Scoping the name lookup (ORG-06) was half the fault. An id already in hand was
still trusted, and a quote row carries the supplier id resolved for whoever
quoted the material, not necessarily the client being drafted for. Hours after
the name lookup was scoped, Agent 02 copied a quote's id straight onto a
California Chemicals thread, which then pointed at a supplier record California
Chemicals does not own.

A supplier id arrives two ways, and both are the same fault: copied off a row we
are reading (a quote, a lead), or posted to an agent API by a caller that may be
working for a different client. Neither is evidence of ownership.

**Enforcement:** Guard — the shared resolver `scopedSupplierId` in
`src/lib/tenkara-supplier-linker.ts`, and `orgs/supplier-id-written-must-be-scoped`,
which fails the build on both arrival paths: a `draft_references` write taking an
id off a row, and any agent API route storing an id off the request body.

## ORG-11 — Unknown is not ambiguous

Where candidate rows are tested for agreement, only the values they actually
name may disagree. A null means the field was never filled in; counting it as a
distinct value turns "we have not linked this yet" into "these are two different
suppliers" and refuses a match that is not in doubt.

ORG-04 sends an ambiguous reply to triage, which is right, and the test for
ambiguity was keying on `supplier_id ?? ""`. Half of all cold outreach is
written before the supplier link exists — 1,935 rows of 3,890 on 2026-08-20 —
so the cold_outbound row on a thread says `null:material` and the follow-up on
the same thread says `supplier:material`. Two members in the set, refused as
ambiguous, every time, on a conversation with exactly one counterparty. All 43
conversations that missed in the 30 days to 2026-08-20 failed here — 37 of them
resolve cleanly once a null stops counting as a value — and California
Chemicals suppliers' prices never arrived because of it. The refusal then stages
a triage draft carrying two nulls of its own, onto the same thread, so the test
could never pass again.

This is safe only where the grouping already establishes identity: a thread id
or a draft id is one conversation with one counterparty. A sender's domain is
not — it is a shared mail host, and an unlinked row behind it may be a different
company — so the domain and address fallbacks keep the strict test.

**Enforcement:** Guard — `soleReplyTarget` in `src/lib/org-isolation.ts`,
`orgs/candidate-match-must-not-key-on-null`, which fails the build on a
`supplier_id ?? ""` or `material_id ?? ""` match key in the inbound router.

## ORG-07 — Unaudited edge

The inbox application is not in this repository, so the uniqueness scope of the
external reference, inbound reply matching, and thread merging are enforced
caller-side only and are not audited.

**Enforcement:** None. Known gap.

## SUP-01 — Suppliers are unique per client

The same company qualified for two different clients is two supplier records
on purpose, never a duplicate. All sourcing work is per client: a supplier's
history, contacts, do-not-contact standing and quotes for one client say
nothing about another. Any duplicate detection, clustering or merge, the
hand-run dupe scan, the online duplicate guard, or any future version, may
only ever compare records that share a client; cross-client matches are
excluded by definition. A scanner may read across clients to build shared
guards, but may never cluster across them.

Sam stated it directly on 2026-08-19, after a scan clustered the same company
across clients and proposed merges that would have leaked one client's sourcing
history into another's. Scoping the comparison to shared clients took the naive
count from about 2,020 clusters to 763: 71% of the matches were cross-client
and wrong.

**Enforcement:** Guard — `orgs/duplicate-guard-requires-exclusive-supplier`
covers the online guard; the hand-run scan unions pairs only when their
client sets intersect, enforced in its own code outside this repository.
