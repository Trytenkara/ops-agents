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

Measured 2026-08-05 on Agent 06: across 8,109 enriched leads that had a website
and no email, the pattern battery had produced zero names. One EC21 page
printing `Phone: 86 - 175 - 03221173 / Contact: kevin zhao` resolved as no
phone and no contact, because the digits are grouped 2-3-8 with no plus and
"Contact" is not a job title. Sam, on being offered a pattern for it: "no i
dont want unit fixes - its a fix for the code to do better."

Shipped as `contact-read.ts`, which hands the HTML already in memory to a model
and is gated to run only when the crawl found no email, no phone and no name.
The shape generalises: patterns first for the common case, a model read on the
residue, and the model is told to copy and never infer (DATA-01).

**Enforcement:** Judgement.

## META-08 — Never filter your own diagnostic output

A broad `grep -vi` over a log eats the line that explains the failure. Print
error bodies in full while diagnosing. Slice a field only after reading it
whole at least once.

Three incidents, all the same shape: the display lied and the code was fine.

- 2026-06-12: a filter written to hide a Postgres SSL warning included the word
  `current`, which silently removed "Could you share your current pricing" from
  every Agent 15 draft printed. Several deploy-and-rerun cycles went into a
  missing pricing ask that was never missing.
- 2026-08-11: diagnosing the SourceReady outage, upstream responses were
  printed as `txt[:220]`. That clipped `code: CREDITS_EXCEED_LIMIT, message:
  credits exceed limit` down to `sourceready check`, so a plain quota error
  read as an opaque server fault. A confident wrong diagnosis was written to
  memory and reported to Sam, who overturned it with one question.
- 2026-08-20: `git diff -U0 | grep -E '^[+-][^+-]'` dropped every removed
  prompt bullet, because `- MATERIAL SCOPE ...` renders as `-- MATERIAL SCOPE`
  in a diff and matches the exclusion. Caught before shipping, but it is the
  same rule breaking in the session that was auditing the rules.

The corollary: prefer calling a tool through its real connection over a
hand-rolled client, because then there is no display layer of yours in between
to mangle the error.

**Enforcement:** Judgement.

## META-09 — A guard is not a guard until a deliberate break makes it fire

Writing the check is the easy half. A check that matches nothing produces the
same green build as a check that finds nothing wrong, and the ledger reports
both as `Guard`. `COMM-08` was published as enforced while its pattern matched
zero of the 1,083 lines it was written to catch; `copy/sanitize-must-strip-concessions`
tested for a bare identifier, so renaming the constant left the check matching
and a comment naming it would have satisfied the check on its own.

So every `Guard` owes a mutation in `scripts/lib/rule-self-test.mjs` that
breaks the codebase on purpose and expects that check's id back. Assert the
symbol is *used*, on a word boundary and outside comments — not merely present.
A check that cannot be made to fire is downgraded to `Check owed` and listed in
`OUTSTANDING.md`. Deleting the mutation to get a green build is the break.

Owing a mutation was itself only a convention until 2026-08-20. The self-test
collected the set of covered ids and used it to print a count, never to demand
anything, so a check added with no mutation behind it read exactly like one that
had passed. `density/solids-require-bulk` was added that day with no mutation,
under an id the ledger named and the code did not use, reading both of its files
through `files.find(...)` so that renaming either one disabled it in silence:
three of the failure shapes this rule exists to catch, inside a check written to
enforce it, one day after the rule was written. The self-test now reads the
declared id of every check out of the source and fails on any that no mutation
expects. The id has to be read rather than observed, because a check only
announces itself when it fires and the ones being hunted never fire.

A guard that is switched off is inert in the same way, and harder to see.
`core.hooksPath` is local machine config, so a committed hook does nothing until
someone sets it, and a repository with its hooks off is indistinguishable from
one where every hook passed. The skills repository had no installer at all, and
its commit hook is the only thing checking the agent skills against these rules.

**Enforcement:** Guard — `npm run check:rules:self-test`, which runs ahead of
`next build`, so an inert guard fails the deploy. It fails on two separate
things: a mutation its check did not catch, and a check no mutation covers.
Plus `scripts/install-hooks.mjs`, which installs both repositories' hooks from
`npm install`, with `check-rules` refusing to pass locally while either has its
hooks unset.
