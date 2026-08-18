# Working rules for this repo

These are standing rules for anyone (human or agent) changing this codebase.
They are versioned here on purpose: a rule that only lives in one person's
notes or one agent's memory is not enforced, it is remembered.

## Every rule and correction becomes code, permanently

When someone states a rule, a preference, or a correction, the job is not done
when the reported symptom is gone. It is done when the rule is enforced in code
everywhere it applies, so it cannot be broken again by a different code path, a
new agent, or a future change.

For every correction:

1. Fix the reported instance.
2. Grep for EVERY other place the same class of mistake can occur, and fix
   those in the same change.
3. Put the guard where the rule can be broken (one shared helper, validator,
   type, or gate) instead of restating the rule at each call site.
4. Write it here so it outlives the session.
5. Say what the long-term enforcement is, not just what was patched. If the
   class-wide fix is too large for the current change, ship the instance fix
   and name the class fix as OUTSTANDING. Do not let it go quiet.

Never ship a workaround that routes around a broken shared component while
leaving that component broken. If a new agent or branch exists only to dodge a
bug, the bug is still open.

**Prefer a positive invariant over a blocklist.** A list of bad values is never
complete. The already-contacted check used a ten-entry list of Western consumer
email providers, so every supplier on a Chinese, Indian, Korean or Russian
mailbox was collapsed into one "already contacted" company and never written
to. The fix was not a longer list, it was inverting the rule: widen to a whole
domain only when it provably matches the supplier's own website host, and fall
back to an exact-address match otherwise. See `src/lib/mailbox-domain.ts`.

## Invariants that already have a home in code

Add to a shared module rather than re-implementing. If you find a second copy
of any of these, delete it and import the shared one.

- `src/lib/mailbox-domain.ts` — when two email addresses may be treated as the
  same company. Never hardcode a consumer-provider list anywhere else.
- `src/lib/material-aliases.ts` — a material's trade names. Every discovery
  source must search these, not just the client's intake-form string, and must
  feed them to its own relevance filter too. Aliases must never add a grade,
  purity or refinement qualifier the input lacked.
- `src/lib/contact-guard.ts` — agents may never invent an address, phone number
  or email in an outgoing body. Enforced at the staging chokepoint, not by
  prompt instruction.
- `src/lib/lead-dupe-guard.ts` — what counts as a duplicate supplier.
- `src/lib/org-isolation.ts` — one client's outreach may never land on another
  client's conversation. `orgScopedExternalId` for any Tenkara idempotency key
  (Tenkara returns the EXISTING conversation and draft for a repeated
  `external_id`, so an unscoped key silently shares one draft between two
  clients), `orgScopedKey` for any supplier/email grouping map, and
  `foreignOrgRows` before folding a set of leads into one draft. Never build an
  `external_id` or a supplier group key by hand.
- `src/lib/org-priority.ts` — who drains a shared capped queue first. Real
  clients before internal test orgs. Never hand-roll an `is_internal` sort.
- `src/lib/fx.ts` `normalizeToUsd` — the ONLY way to publish a foreign price.
  One rate per listing. Never call `convertToUsd` per amount: a failed lookup
  then falls back to the raw foreign number and publishes yuan as dollars.
- `src/lib/email-style.ts` `sanitizeDraft` — applied inside `stageDraft`, so
  outbound copy cannot carry "RFQ" or an em dash. Do not rely on a drafter
  remembering to call it.
- `src/lib/supabase-paging.ts` `selectAllPaged` — use for any worklist read.
  A bare `.select()` silently stops at 1000 rows.
- `src/lib/requirements-recheck.ts` `recheckOrgLeads` — a client/material/grade
  change re-judges EXISTING leads, not only future ones.
- `src/lib/supabase/truncation-guard.ts` — every Supabase client refuses an
  unbounded read that comes back at exactly the 1000-row cap, because PostgREST
  drops the rest without an error. Page it with `selectAllPaged`, or state the
  bound with `.limit()` if a partial answer is genuinely wanted.
- `src/lib/retry-verdict.ts` `classifyFailure` — whether a failure earns another
  attempt. Default is RETRY: only a structural verdict (not authorised, rejected,
  out of credit) is terminal. A 404 is NOT terminal, it is repairable by search.
  Never hand-roll another `retryable()` regex.
- `src/lib/price-publish.ts` `publishablePrice` / `publishableTiers` — the last
  gate before a price is stored. Unreadable, negative, implausible, or still in a
  foreign currency means null plus a stored reason, never a guess.

## How these are enforced

`scripts/check-rules.mjs` runs as the first step of `npm run build`, so a rule
break fails the Vercel build and never reaches production. Run it on its own
with `npm run check:rules`. Rules covered today: no direct `convertToUsd`, no inline
consumer-mailbox list, no hand-rolled `is_internal` sort, no native `<select>`,
no "RFQ" or em dash in a copy literal, `stageDraft` keeping both `sanitizeDraft`
and the contact-fabrication guard, every Supabase client keeping the truncation
guard, every price writer going through the publish gate, `stageDraft` keeping
the org scoping on `external_id`, and every direct `createTenkaraConversation`
caller scoping its key too. Add a check when you add a shared guard. Reach for an
exemption only when you have first ruled out moving the logic into the shared
module, since an exemption list decays the same way a blocklist does.

Main deploys straight to production, and a failed build is silent: production
keeps serving the previous deploy. A type error once sat red on main for hours
that way. A pre-merge check on pull requests is still missing:
`.github/workflows/ci.yml` is written but cannot be pushed until the deploy
token carries the `workflow` scope. Until then the Vercel build is the only gate,
and it runs after the merge.

## Org isolation reaches the schema too

One client's data may never appear under another client's name.
`org-isolation.ts` covers the keys we build in code; migration 0120 closed the
three keys that lived in the database instead:

- `supplier_email_context` is unique on `(org_id, supplier_email)`, not on the
  address alone. It used to keep ONE row per supplier address fleet-wide, and
  Agent 02 reads that row to pick its tone.
- `document_page_scans` is unique on `(org_id, page_hash)`, not `page_hash`
  alone. The URL hash as a primary key let the first client to scan a supplier's
  document page block every other client for 60 days.
- `lead_scanner_exports` has an `org_id`, so Agent 11's 7-day "already exported"
  suppression is per client rather than fleet-wide.

Both halves have to move together: a unique key naming `org_id` and an
`onConflict` that does not will fail at runtime, and the reverse silently
overwrites another client's row. Rule
`orgs/upsert-conflict-key-must-include-org` in `check-rules` holds the writer
side. If you add another table whose natural key is shared between clients (an
address, a URL, a domain), add its column to `ORG_SCOPED_CONFLICT_KEYS` there.

Still caller-side only: the Tenkara inbox app is not in this workspace, so
`external_id`'s own uniqueness scope, inbound reply matching and thread merging
are unaudited.

## Rules the guards cannot fully carry

The modules above stop the bad WRITE. They cannot supply the judgement that
should have happened earlier, so these still need attention by hand:

- A discovery pass that returns ZERO is not "this market is empty". The
  SourceReady path now requeues a dry pass and only gives up after three, but
  any NEW source has to make the same choice on its own. Zero is
  indistinguishable from a naming miss or a crashed run.
- No hidden caps on a worklist. The truncation guard catches the accidental
  1000-row cut, not a deliberate `top N` window. If a run is bounded, say in its
  summary what it left behind.
- A withheld price is a job, not an outcome. `publishablePrice` stores the
  reason; somebody still has to work the flagged rows.
