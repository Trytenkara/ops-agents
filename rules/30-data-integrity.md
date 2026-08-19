# Data integrity: never fabricate

The shared principle: a blank with a stored reason is always better than a
plausible number. A blank is visibly missing; a wrong number is silently
believed and quoted to a client.

## DATA-01 — Never fabricate, approximate or infer a price

If a price cannot be read, store null plus the reason WHY. Never estimate from
a similar product, a previous listing, or a range. The price basis (per kg, per
drum, per case) is read from the page too, never derived.

**Enforcement:** Guard — `src/lib/price-publish.ts` `publishablePrice` /
`publishableTiers` at every price writer, `price/writer-must-gate`.

## DATA-02 — A foreign price is published only through one conversion

`normalizeToUsd` in `src/lib/fx.ts` is the only way a non-USD price reaches
storage, and it takes one rate per listing. Calling a per-amount converter with
a fallback to the raw value republished yuan as dollars when a lookup failed.
An unconvertible listing nulls every amount on it.

**Enforcement:** Guard — `fx/no-direct-convertToUsd`.

## DATA-03 — FX rates refresh daily, not intraday

Free feeds publish once a day. Do not present a rate as live.

**Enforcement:** Honour.

## DATA-04 — Agents may never invent a contact detail in an outgoing body

No invented address, phone number or email in the text of a message to a
supplier. Enforced at the staging chokepoint, not by asking a drafter to
remember.

**Enforcement:** Guard — `src/lib/contact-guard.ts`,
`contacts/staging-must-guard-fabrication`.

## DATA-05 — Guessing a recipient is allowed; guessing content is not

DATA-04 governs the BODY. The recipient envelope is different: when contact
finding returns a real person's name at a supplier's own corporate domain but
no verified address, generate the standard patterns, put the most likely in To
and copy the rest. This is safe only because nothing auto-sends (AUTO-06) and a
human sees the draft.

Conditions, all required: a real name, the supplier's own domain (never a
marketplace or platform host), and the payload flagged as guessed so an
operator can see it.

**Enforcement:** Honour. Owed guard: reject a guessed combo whose domain is a
known platform host, and require the guessed flag. See `OUTSTANDING.md`.

## DATA-06 — Only a same-run verification counts as a confirmed email

A verification provider's verdict is not stable across runs. Only a `valid`
result from the same run is treated as confirmed. Everything else with a known
name is a guessed combo under DATA-05, not a confirmed contact.

**Enforcement:** Honour.

## DATA-07 — Density: bulk for solids, specific gravity for liquids

Volume to mass conversion uses specific gravity for a liquid and BULK density
for a solid. True or crystal density is rejected outright; it overstates a
packed weight badly. A bare crop or commodity name with no form given resolves
to null with a reason, not to a typical value.

**Enforcement:** Honour, partially held by the enrichment sanitiser.

## DATA-08 — A dealbreaker grade is a hard specification

When a client states a required grade, never widen the ask, never invite a
nearby grade or a different source material, and never treat an adjacent grade
as a near match worth drafting.

**Enforcement:** Honour, held by a QA lint that is inert when the client record
has no required grade set. Verify the live client record before relying on it.

## DATA-09 — Aliases never add a qualifier the input lacked

A trade alias may rename a material, never re-specify it. "Palm Oil" must never
resolve to "Crude Palm Oil". Grade, purity and refinement words are blocked in
code, not left to a prompt.

**Enforcement:** Guard — `GRADE_WORDS` in `src/lib/material-aliases.ts`.
