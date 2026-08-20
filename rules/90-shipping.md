# Shipping: how an update reaches production

`main` deploys straight to production. There is no staging step and no second
pair of eyes by default, so the gates below are the whole safety system.

## SHIP-01 — Push to `main`

No feature-branch and pull-request dance unless asked for. A push to `main` is
a production deploy and is treated as one.

**Enforcement:** Judgement.

## SHIP-02 — Never stage everything

Never `git add -A` or `git add .`. Stage explicit paths. This checkout is
shared and often holds other people's uncommitted work; a blanket stage once
swept another agent's in-progress files into an unrelated commit. Check what a
commit actually contains before pushing, including commits you did not make.

**Enforcement:** Check owed — a pre-commit hook that refuses paths outside
those explicitly staged. See `OUTSTANDING.md`.

## SHIP-03 — A red build is silent, so build before you push

A failed build does not roll back and does not alert. The platform keeps
serving the previous deployment and nothing anywhere says so. `main` sat red
for five days that way, with a week of merged work undeployed while everything
looked normal.

`.githooks/pre-push` runs the build and refuses a push to `main` that does not
compile. The `prepare` script points git at it so `npm install` wires it up.
`--no-verify` bypasses it; only use that when you have already built.

**Enforcement:** Guard — pre-push hook, on machines that ran `npm install`.

## SHIP-04 — Rules are checked before the build

`scripts/check-rules.mjs` is the first step of `npm run build`, so a rule break
fails the deploy. Add a check whenever you add a shared guard. Reach for an
exemption only after ruling out moving the logic into the shared module; an
exemption list decays the same way a blocklist does.

**Enforcement:** Guard.

## SHIP-05 — Confirm what production is actually serving

A push is not a deploy and a deploy is not a working deploy. After pushing,
confirm the remote has the commit and that the running deployment is the new
one. Report the confirmed outcome (COMM-04). If it was not confirmed, say it
was not confirmed.

**Enforcement:** Judgement. This is the rule whose breach reads as "fake
pushing".

## SHIP-06 — The deploy gate must not depend on one machine

The pre-push hook only exists on a checkout that ran `npm install`, and any
push with `--no-verify` skips it. A build on the hosting side, running on every
push, is the only version of this gate that cannot be bypassed.

**Enforcement:** None. A workflow file exists on disk but has never been
committed, because the token used to push is not permitted to create one. See
`OUTSTANDING.md`. This is the single largest hole in the shipping process.

## SHIP-07 — Deploy and schema move together

A change that needs a database migration is not shipped until the migration is
applied to the same environment. Deploying the code ahead of the migration
leaves production running against a schema that does not have the columns it
reads.

**Enforcement:** Check owed — `ship/migration-must-accompany-schema-read`.

## SHIP-08 — Weekly rules review

Once a week: what rules were added, what checks were added, what is still on
the outstanding list, and anything where two rules contradicted each other.
Short, and to Sam.

The review reports what *moved* since the last one, not the whole book. A
weekly dump of every rule is ignored by the third week, and the faults worth
catching are all changes: a guard that quietly became owed, a new rule with no
check behind it, a conflict left waiting on a ruling.

**Enforcement:** Audit — `agent-25-rules-review`, weekly. It reads a snapshot
of the rulebook generated at build time, and the build refuses if that snapshot
has drifted from the rule files, so the review cannot report a rulebook that no
longer exists.
