# Meta: how rules work

## META-01 — Every rule and correction becomes code, permanently

When someone states a rule, a preference, or a correction, the job is not done
when the reported symptom is gone. It is done when the rule is enforced
everywhere it applies, so it cannot be broken again by a different code path, a
new agent, or a future change.

For every correction: fix the instance, grep for every other site of the same
class and fix those in the same change, put the guard in one shared place
rather than restating the rule at each call site, write it in this folder, and
say what the long-term enforcement is rather than only what was patched. If the
class fix is too large for the current change, ship the instance fix and name
the class fix as OUTSTANDING. Do not let it go quiet.

A single-site edit in response to a general rule is a spot fix and is not
acceptable on its own.

**Enforcement:** Judgement. Process rule; partially visible via
`scripts/check-rules.mjs` coverage and the weekly review (SHIP-08).

## META-02 — Prefer a positive invariant over a blocklist

A list of bad values is never complete. The already-contacted check used a
ten-entry list of Western consumer email providers, so every supplier on a
Chinese, Indian, Korean or Russian mailbox collapsed into one "already
contacted" company and was never written to. The fix was not a longer list, it
was inverting the rule: widen to a whole domain only when it provably matches
the supplier's own website host, otherwise match the exact address.

**Enforcement:** Guard — `src/lib/mailbox-domain.ts`,
`contacts/no-inline-mailbox-list`.

## META-03 — Never route around a broken shared component

If a new agent, branch, skill or container job exists only to dodge a bug in a
shared component, the bug is still open. Name it as open until it is fixed at
the source. A skill-based sweep that compensates for a gap in a shared guard is
a workaround, not a fix, and must appear in `OUTSTANDING.md`.

**Enforcement:** Judgement. Visible only because a workaround must be
written into `OUTSTANDING.md` when it is made.

## META-04 — One shared module per invariant

If you find a second copy of a guard, delete it and import the shared one. Two
copies of a rule agree only by inspection, and one day one of them will not.
The open-record owner derivation existed in four places; three agreed and the
fourth stamped the wrong operator on every externally-staged draft.

**Enforcement:** Guard for the invariants that have a `check-rules` id.
Check owed — `meta/no-second-copy-of-a-shared-guard`, extending coverage to
the rest.

## META-05 — Ad-hoc scripts live in `scripts/` and get deleted

`tsconfig.json` compiles `src/` only, because a throwaway debugging script left
in the repo root once became part of the production build and broke it.
Scratch files still get committed by accident, so delete them when done.

**Enforcement:** Guard — `tsconfig.json` include scope.

## META-06 — Always verify current live status; never answer from memory

Memory records what was true when they were written. Before answering a
question about production, schema, org settings, agent schedules or data
volumes, read the live source. If a remembered fact conflicts with what you
observe, trust the observation and correct the record.

**Enforcement:** Judgement.

## META-07 — Read, do not pattern-match

When an extractor misses, the fix is to have a model read the page, not to add
another regex or another unit special-case. Each new pattern only covers the
example in front of you and grows a blocklist by another name.

**Enforcement:** Judgement.

## META-08 — Never filter your own diagnostic output

A broad `grep -vi` over a log eats the line that explains the failure. Print
error bodies in full while diagnosing.

**Enforcement:** Judgement.
