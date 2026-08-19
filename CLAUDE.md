# Working rules for this repo

**The rules live in [`rules/`](./rules/). That folder is the single source of
truth. Read it before changing this codebase.**

This file used to hold them. It no longer does, because the same rules also
lived in a container instructions file and in twenty-two separate memory notes,
none of which agreed, and rules kept getting lost in the gaps.

Start with [`rules/README.md`](./rules/README.md): what is in each file, how a
rule is written, and how to add one.

Two files to read every time:

- [`rules/OUTSTANDING.md`](./rules/OUTSTANDING.md) — rules with no machine
  guard yet, and the breaks currently live because of it.
- [`rules/CONFLICTS.md`](./rules/CONFLICTS.md) — rules that contradict each
  other, and the ruling. Check here before assuming a rule is absolute.

## The short version

Every rule and correction becomes code, permanently. Fix the instance, grep for
every other site of the same class, put the guard in one shared place, write it
in `rules/`, and say what the long-term enforcement is. If the class fix is too
big for this change, ship the instance fix and add it to `OUTSTANDING.md`.
Never route around a broken shared component and leave it broken.

`scripts/check-rules.mjs` is the first step of `npm run build`, so a covered
rule break fails the deploy. `.githooks/pre-push` refuses a push to `main` that
does not compile. `main` deploys straight to production and a failed build is
silent, so confirm what production is actually serving before saying it shipped.
