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

## OUTSTANDING: rules with no shared guard yet

Named here so they stay visible instead of going quiet. Enforce them by hand at
every call site you touch, and if you are already in the area, build the guard.

- **Paging.** `selectAllPaged` exists but only ~10 files use it against ~167
  files with a bare `.select(`. Needs a lint rule that fails CI on an unpaged
  `.select()` with no single-row filter, otherwise the next worklist read is
  silently truncated at 1000 rows.
- **Retryable vs terminal.** At least four agents hand-roll their own
  `retryable()` regex test. Needs one `lib/retry-verdict.ts` classifier that
  every pull and enrichment agent throws and catches through.
- **Zero is not empty.** Each discovery source reasons about this separately in
  comments. Needs a shared `DiscoveryResult` that requeues on an empty pass, so
  a new source cannot report "no suppliers exist" after a bad run.
- **No fabricated price.** Enforced by prompt text in each extractor, with no
  write-time validator. `price-qa.ts` is a read-time pass and cannot prevent it.
- **Native `<select>`.** None exist today and 26 files use the app `Select`, but
  nothing stops a new one. Needs an eslint `no-restricted-syntax` rule.

## Rules with no single home yet, enforce at every call site you touch

- Never fabricate a price. Unreadable means null plus the reason, never a
  guess. Non-USD converts to USD, never publish an unconverted number.
- A discovery or pull pass that returns ZERO is not "this market is empty".
  Zero is indistinguishable from a naming miss or a crashed run, so requeue it.
- Never give up on a retryable failure. Only a structural verdict is terminal.
- No hidden caps on a worklist. Page to completion, and if a run is bounded,
  say in its summary what it left behind.
- PostgREST caps a select at 1000 rows. Page with `.range()` or your counts are
  silently wrong, not merely short.
- Real clients (`orgs.is_internal = false`) drain a shared capped queue before
  internal test orgs.
- Outbound copy: say "sourcing inquiry", never "RFQ". No em dashes.
