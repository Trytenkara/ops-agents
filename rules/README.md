# Rules

This folder is the single source of truth for every standing rule in this
system: how agents behave, what they may never do, how work reaches
production, and how we talk about it afterwards.

It lives in the repo on purpose. A rule that lives in one person's notes or in
one agent's memory is not enforced, it is remembered, and remembered rules get
lost. Anything in here is versioned, reviewed, and travels with the code.

## The files

| File | Holds |
|---|---|
| `00-meta.md` | How rules themselves work: class-fix discipline, how to add one |
| `10-communication.md` | Reply style, evidence, Slack, who may speak as whom |
| `20-autonomy.md` | What an agent decides alone, what it escalates, what it never touches |
| `30-data-integrity.md` | Never fabricate: prices, currency, contacts, density |
| `35-marketplace-pricing.md` | Prices read off listings, and delivery-cost capture |
| `40-persistence.md` | Never give up: retries, zero results, hidden caps, flagged work |
| `50-discovery.md` | Trade aliases, sources, relevance, duplicates |
| `60-outreach.md` | Drafting, threading, internal notes, channels, copy bans |
| `70-org-isolation.md` | One client's data may never appear under another's name |
| `80-control-room.md` | Product and UI rules |
| `90-shipping.md` | Git, build gates, deploy, how an update reaches production |
| `ENFORCEMENT.md` | Every rule and whether anything actually stops it being broken |
| `OUTSTANDING.md` | Rules with no machine guard yet, and who owes what |
| `CONFLICTS.md` | Rules that contradict each other, and the ruling |

## How a rule is written

Every rule gets a stable id (`DATA-03`), a one-line statement, the reason it
exists (usually an incident), and an **Enforcement** line.

The Enforcement line is mandatory and its first words come from a fixed
vocabulary. There is no "we'll be careful" option, because that is what the
old `Honour` status was and 51 rules accumulated under it, every one reading
as protected and none of them protected:

| Begins with | Means |
|---|---|
| `Guard — <module or check-rules id>` | Built. A check or shared module makes the break impossible. |
| `Audit — <job>` | Built. A scheduled job reports the break afterwards. |
| `Check owed — <check-rules id>` | A build check is possible and is not built yet. |
| `Audit owed — <job>` | No build check can see it; a scheduled job can. Not built. |
| `Judgement.` | Nothing mechanical could ever verify this. Human, by design. |
| `None.` | Outside this repository; cannot be checked here. |
| `Retired <date>` | No longer applies. |
| `See <RULE-ID>.` | Restates a rule enforced elsewhere. |

Two things follow from that, both enforced by `check-rules`:

- A rule that does not use the vocabulary fails the build.
- Anything **owed** must also be named in `OUTSTANDING.md`, so a debt cannot
  go quiet. Clearing it means building the thing, or reclassifying the rule as
  `Judgement` and saying why nothing could ever check it.

Reach for `Judgement` last. It is the honest answer for "keep replies short"
and the wrong answer for anything a script could look at.

`ENFORCEMENT.md` is the ledger of every rule and its status. It is generated
by `npm run gen:enforcement`, never hand-edited; regenerate it whenever you
add or reclassify a rule.

Ids are permanent. If a rule is retired, mark it RETIRED in place with the
date and the reason; never reuse or renumber.

## How to add or change a rule

A new rule is not landed until all four exist in the same change:

1. The instance fix (the thing that went wrong is fixed).
2. Every other site of the same class fixed, found by grep, not by memory.
3. An entry in the right file here, with an Enforcement line.
4. A check in `scripts/check-rules.mjs` that fails the build when the rule is
   broken, OR an entry in `OUTSTANDING.md` naming the check that is owed.
5. `npm run gen:enforcement`, so the ledger matches.

Prefer a positive invariant over a blocklist. A list of bad values is never
complete; a rule that says what IS allowed is.

Prefer one shared module over the rule restated at each call site. If you find
a second copy of a guard, delete it and import the shared one.

Never ship a workaround that routes around a broken shared component while
leaving that component broken. If a new agent, branch or skill exists only to
dodge a bug, the bug is still open and stays named as open.

## How this is enforced

`scripts/check-rules.mjs` is the first step of `npm run build`, so a break
fails the Vercel build and never reaches production. Run it alone with
`npm run check:rules`.

`.githooks/pre-push` runs the build and refuses a push to `main` that does not
compile. `npm install` wires it up via the `prepare` script.

Neither gate can be trusted on a machine that never ran `npm install`, and
`--no-verify` bypasses the hook. See `OUTSTANDING.md`.
