# Conflicts between rules, and the ruling

Rules given at different times pull against each other. Where that is not
resolved in writing, each session picks a side and the behaviour looks
inconsistent. Every conflict found gets a ruling here, or is marked OPEN with
the decision that is needed.

## A — Short replies vs. paste the evidence — RESOLVED

"Keep replies to a few sentences, no commit ids or file paths" against "after a
push, paste the evidence".

**Ruling:** COMM-04. State the verified outcome in plain words; keep the raw
evidence in the session and the commit message and produce it on request. If
verification did not happen, say so.

## B — Never post outside the feedback channel vs. DM on failure vs. never speak as Sam — DISSOLVED 2026-08-19

Three rules used to fire on one action: a guard ended the session on any
channel that was not the feedback channel, which also killed the sanctioned
failure DM.

**Ruling:** there is no longer a second destination to conflict over. Sam
consolidated everything into `#op-assistant-agents`, and the failure DM is
retired along with the exception that justified it (COMM-06, COMM-07). Output
still always goes out as the bot, never as Sam (COMM-05). Nothing to reconcile.

## C — Never fabricate a contact vs. pattern-guessed email addresses — RESOLVED

**Ruling:** DATA-04 governs the BODY of a message and stays absolute. DATA-05
governs the recipient envelope, is permitted, and is safe only because nothing
auto-sends. The distinction is envelope versus content, and it was never
written down before.

## D — Cap the spend never the attempts vs. the three-strike discovery requeue — RESOLVED

A source that gives up after three dry passes is an attempt cap, which PERS-01
forbids.

**Ruling:** PERS-04. Bounded retries are allowed only as an explicit spend
control, only where the bound is written here and stated in the run summary.
The existing three-pass bound is recorded. Any other silent bound is a break.

## E — Never give up vs. leads parked with a website and no email — RESOLVED

Leads that reach the enriched state with a website but no email are not
retried; a scheduled sweep compensates.

**Ruling:** PERS-05. The sweep is a workaround under META-03, so the underlying
gap stays open until the enriched-no-email set is retried by the same queue as
everything else.

## F — Surface everything vs. no global surfaces vs. no clutter vs. no surfaces over read-only data — RESOLVED

Together these left flagged prices and similar exception sets with nowhere
legal to live.

**Ruling:** UI-02, UI-06, PERS-06. Exception sets live on the owning client's
own tab, uncapped, with any window named on screen. Read-only external data is
never the subject of a review screen, but our own flag on our own record is not
read-only data and does get a surface.

## G — "Needs a human" is a display flag vs. someone must work the flagged rows — RESOLVED

**Ruling:** PERS-02 plus UI-06. The flag never removes the record from its
retry queue, AND the flagged set is rendered on the client's tab. Both, not
either.

## H — A platform is never the supplier vs. marketplace storefronts get drafted — RESOLVED

"Directory host" appeared as a terminal give-up verdict while storefronts were
also required to be drafted.

**Ruling:** DISC-05 is a classification rule, OUT-02 is a routing rule. The
terminal verdict applies to a listing page that sells nothing, not to a
storefront with a seller behind it.

## I — Autonomous discovery vs. the shared alias resolver — RESOLVED

Older guidance told a run to invent a more generic search term on its own,
which predates the shared resolver and conflicts with META-04.

**Ruling:** DISC-01. The resolver decides aliases. A run does not hand-roll a
substitution.

## J — Two definitions of "no hidden caps" — RESOLVED

One version said page to completion, the other said name the window.

**Ruling:** PERS-06. Both: page to completion, and where a window is genuinely
correct, name it where it is visible.

## K — Em dash and RFQ ban: scope — OPEN

The written rule says "any output, ever". The build check covers recognised
copy literals in supplier-facing templates only. Internal documents, chat
replies and model prompts are not covered, and this folder itself would fail a
literal reading.

**Decision needed:** does the ban bind supplier-facing and client-facing copy
only, or all output including internal notes? Current behaviour is the former.

## L — The dealbreaker grade rule states its own premise is false — OPEN

The rule stands, but its enforcement is inert for the flagship live client
because the required-grade field is unset there, and the record does not say
whether the field was cleared or the original write-up was wrong.

**Decision needed:** confirm against the live client record whether a required
grade should be set. Until then treat the rule as stated but unenforced.
