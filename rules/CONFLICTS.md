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

## K — Em dash and RFQ ban: scope — RULED 2026-08-20

The written rule said "any output, ever". The build check covered recognised
copy literals in supplier-facing templates only. Internal documents, chat
replies and model prompts were not covered, and this folder itself would fail a
literal reading.

**Ruling (Sam, 2026-08-20):** the ban binds supplier-facing and client-facing
copy **and the model prompts that generate it**. Prompts are in scope because
they are upstream of the copy and no runtime sanitiser can reach them.

Out of scope, and deliberately so: internal notes and case resolution notes,
operator alerts and Slack messages, run logs, Control Room labels an operator
reads, this rules folder, code comments, and prompts that do not write outbound
copy (the discovery scout, for one). None of those reach a supplier or a client.

Implemented as the `OUTBOUND_COPY` scope list in
`scripts/lib/rule-checks.mjs`. A named list rots quietly, so it is held closed
from both ends: each path is an anchor, so a rename fails the build, and
`copy/scope-must-cover-every-draft-site` makes any `stageDraft` caller absent
from the list a violation in its own right. Twenty-eight breaches were live
when the ruling was applied, including one in a client deliverable.

## L — The dealbreaker grade rule states its own premise is false — RULED 2026-08-20

DATA-08 carried a note saying its own enforcement was inert, because on
2026-08-04 every California Chemicals material had `isDealbreaker: false`, and
the record did not say whether the field had been cleared or the original
write-up was wrong.

**Ruling:** the rule stands, and the premise recorded against it was wrong in
both directions. Checked against live Tenkara and 5,519 staged drafts on
2026-08-20:

- The rule is not unenforced fleet-wide. 246 dealbreaker grades are set across
  188 materials, including both of the other real clients: SaponIQ has 4 of 4
  materials flagged and 880 of its 938 drafts carry a required grade, and
  McGinley has 2 of 3 flagged.
- California Chemicals genuinely has none. All 7 of its materials are
  `isDealbreaker: false` today, so the note's observation still holds for that
  client, just not as a statement about the rule.
- The enforcement is neither inert nor sound. It is **intermittent**, which the
  conflict never considered. The same material on the same code path armed 7
  drafts and left 203 unarmed across thirteen days with no Tenkara edit in
  between. The measurement is in DATA-08 and the repair is owed in
  `OUTSTANDING.md`.

Two things that looked like defects and are not. McGinley's 10 drafts all
predate 2026-08-04, when the arming code landed, so its 0-of-10 is history and
not a gap. California's 62 armed drafts name grades that match its own
materials, so they are the same intermittency and not a cross-client leak.

**No decision is needed from Sam on whether California should have a required
grade set.** That is the client's specification to state, and an unflagged
material is a legitimate answer. What was owed here was evidence, and it is now
recorded.

## M — Never speak as the human vs. an explicit instruction to post as them — RULED

COMM-05 is absolute: anything an agent sends goes out as the bot or is staged as
a draft, never through the connected account that posts in Sam's voice.

A memory note written after the original incident records a softer version: do
not post as the user "unless the user explicitly says to post as them for that
specific message". The incident behind it was 2026-07-09, when "let her know
once done" was read as authority to reply in Sam's voice in Mildred's thread.
Sam objected: "why are you messaging as me", then "just dont do that again".

The two readings differ on one case only: Sam says, in as many words, post this
as me. Under the rule the answer is still no, and the agent stages a draft he
sends himself. Under the note the answer is yes.

**Ruled by Sam on 2026-08-20: no.** Asked directly whether an agent should post
as him when he says to, the answer was "NO". COMM-05 is absolute and admits no
per-message exception. Even a plain "send this as me" is answered with a draft
he sends himself.

The reasoning is the asymmetry, not the inconvenience: a draft costs him one
click, and a message in his name he did not write cannot be taken back. So the
softer memory note is wrong and has been deleted; there is no longer any store
that records an exception. Nothing in the memory folder states a rule now.
