# Control Room (product and UI)

## UI-01 — Never ship a native OS dropdown

Use the shared `Select` component. A native `<select>` renders as an OS menu
and breaks the interface everywhere.

**Enforcement:** Guard — `ui/no-native-select`.

## UI-02 — Everything lives on the client's own tabs

No global, cross-client review surface in the navigation. When output is not
visible to an operator, the fix is to surface it on the relevant client's tab,
not to add another entry to a global queue.

**Enforcement:** Check owed — `ui/no-global-review-route`.

## UI-03 — Never build a screen over data this application cannot write to

A review surface over read-only external data is a to-do list with buttons that
do nothing. Act upstream, on the records we own.

**Enforcement:** Judgement.

## UI-04 — The Inbox is a triage queue, not an email client

It surfaces the items needing a human decision, must stay readable at hundreds
of rows, and is not a mirror of the mail application.

The filter that decides what "needs a decision" means is a deliberate window
and must be named on screen (PERS-06).

**Enforcement:** Judgement.

## UI-05 — Clutter is a bug, not a tradeoff

If a screen starts feeling cluttered, that is the signal to restructure it, not
to accept it. This does not license hiding rows: the answer is grouping,
progressive disclosure and a named window, never a silent cap.

**Enforcement:** Judgement.

## UI-06 — Flagged work needs a home

Withheld prices, guessed contacts, ambiguous replies and audit findings each
need a visible place on the owning client's tab. See PERS-07.

**Enforcement:** Check owed — `ui/flagged-set-must-have-a-surface`. See
`OUTSTANDING.md`.

## UI-07 — Seed a real client before judging a view

An empty or test-only view tells you nothing about whether the design works.

**Enforcement:** Judgement.

## UI-09 — A one-click write needs a way back

Any control that writes on a single click, with no confirm step, must offer an
undo, and the undo has to be reachable after the write has taken effect. A
control that closes the row it lives on has to leave the undo somewhere the
operator can still see, not only on the row that just disappeared. Undo takes
back the effect and keeps the audit trail; it never erases the record.

**Enforcement:** Guard — `src/lib/call-undo.ts` `undoLastAttemptPatch`, surfaced
by `UndoCallAttempt` on both the open call task and the recently-closed table.
Judgement for other one-click controls.

## UI-08 — RETIRED: the CSV export sweep

Closed. Do not reopen or resurface it.

**Enforcement:** Retired 2026-08-19.

## UI-10 — A withheld value shows its reason where it renders

When the pipeline deliberately declines to store a value, the surface that
renders it must say so and say why, in the cell itself, not only in the record
behind it. An empty cell reads as "nobody has done this yet" and gets ignored;
"withheld: no currency stated" is a task. The reason travels with the value
into exports too.

**Enforcement:** Guard — the withheld-price cells in
`src/components/staged-quote-row.tsx` and
`src/components/direct-prices-on-file.tsx` (`priceNote`), which render the
capture reason and carry it into the CSV. Judgement for other withheld fields.
