# Data integrity: never fabricate

The shared principle: a blank with a stored reason is always better than a
plausible number. A blank is visibly missing; a wrong number is silently
believed and quoted to a client.

## DATA-01 — Never fabricate, approximate or infer a price

If a price cannot be read, store null plus the reason WHY. Never estimate from
a similar product, a previous listing, or a range. The price basis (per kg, per
drum, per case) is read from the page too, never derived.

`publishablePrice` holds the NUMBER and not the BASIS. It tests finite,
positive, under ten million, and the currency invariant; it cannot see that a
figure was multiplied out of a pack weight or that a per-tonne price was
labelled per kg. On the supplier-email path both went through it stamped
`confidence: high`. The basis half is now held separately by DATA-14: a staged
price that does not reconcile arithmetically against the supplier's own words is
withheld before it reaches this gate.

**Enforcement:** Guard — `src/lib/price-publish.ts` `publishablePrice` /
`publishableTiers` at every price writer, `price/writer-must-gate`, for the
amount; `src/lib/price-provenance.ts` `verifyPriceProvenance`,
`price/capture-must-carry-source-text`, for the basis (DATA-14).

## DATA-02 — A foreign price is published only through one conversion

`normalizeToUsd` in `src/lib/fx.ts` is the only way a non-USD price reaches
storage, and it takes one rate per listing. Calling a per-amount converter with
a fallback to the raw value republished yuan as dollars when a lookup failed.
An unconvertible listing nulls every amount on it.

**Enforcement:** Guard — `fx/no-direct-convertToUsd`.

## DATA-03 — FX rates refresh daily, not intraday

Free feeds publish once a day. Do not present a rate as live.

**Enforcement:** Judgement.

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

**Enforcement:** Check owed —
`contacts/guessed-combo-requires-own-domain-and-flag`: reject a guessed
combo on a known platform host, and require the guessed flag.

## DATA-06 — Only a same-run verification counts as a confirmed email

A verification provider's verdict is not stable across runs. Only a `valid`
result from the same run is treated as confirmed. Everything else with a known
name is a guessed combo under DATA-05, not a confirmed contact.

**Enforcement:** Check owed — `contacts/confidence-derived-from-source`:
confidence is derived from the source, and a same-run provider verdict is
persisted.

## DATA-07 — Density: bulk for solids, specific gravity for liquids

Volume to mass conversion uses specific gravity for a liquid and BULK density
for a solid. True or crystal density is rejected outright; it overstates a
packed weight badly. A bare crop or commodity name with no form given resolves
to null with a reason, not to a typical value.

**Enforcement:** Check owed — `density/solids-require-bulk`. Partially held
today by the enrichment sanitiser.

## DATA-08 — A dealbreaker grade is a hard specification

When a client states a required grade, never widen the ask, never invite a
nearby grade or a different source material, and never treat an adjacent grade
as a near match worth drafting.

Written after a supplier for Avlaan Pharmaceutical was asked, in our own copy,
whether they could supply "both coconut and palm sources" for MCT when the
client had named one of them as a dealbreaker. Inviting the nearby grade reads
to the supplier as though the specification is negotiable, and the quote that
comes back cannot be used.

The guard is real but its trigger is not. `grade_ask_widened` only arms when
`metadata.required_grade` is set on the draft, and that value is resolved from
Tenkara at draft time: only grades flagged `isDealbreaker` count. Measured on
2026-08-20 across 5,519 staged drafts, that arming is unstable. For one
California Chemicals material (Propylene Glycol, unchanged in Tenkara since
2026-08-07) the same agent on the same code path armed 7 drafts and left 203
unarmed over the following thirteen days. Nothing in our code is
non-deterministic here, so the flag itself is moving underneath us. A guard
that fires on 3% of identical cases is not protection, it is a coin toss.

Separately, the guard has never once fired: zero blocks across the 1,129
drafts that were armed. Its pattern does catch the phrasing from the original
incident, so it is not inert in the way COMM-08's was, but it is narrow. It
misses softer invitations that break the rule just as effectively, among them
"coconut-based as well if palm isn't available" and "let us know what else you
stock in this range".

**Enforcement:** Audit owed — a daily check that the arming value is stable for
a material whose Tenkara record has not changed, and that no draft invites an
adjacent grade. `grade_ask_widened` is a blocking code inside `stageDraft` and
does hold part of this, but it is deliberately NOT counted as a guard: it arms
on a value that moved on 97% of one material's drafts with no Tenkara edit
behind it, and a guard that fires on 3% of identical cases makes nothing
impossible. See `OUTSTANDING.md` and `CONFLICTS.md` L.

## DATA-09 — Aliases never add a qualifier the input lacked

A trade alias may rename a material, never re-specify it. "Palm Oil" must never
resolve to "Crude Palm Oil". Grade, purity and refinement words are blocked in
code, not left to a prompt.

**Enforcement:** Guard — `GRADE_WORDS` in `src/lib/material-aliases.ts`.

## DATA-10 — A write that fails is never silent

When a capture write fails, the failure is logged unconditionally, with enough
of the row to identify it, and never behind a debug flag or a counter nobody
reads. A pipeline that stops producing rows must also raise on its own: the
absence of output is the alarm, not the presence of an error.

**Enforcement:** Guard — unconditional `console.error` on insert failure in
`insertStagedQuotes` (`src/lib/staged-quotes.ts`), plus the
`quote_capture_silent` check in the QA watchdog, which fires when supplier
replies keep arriving and nothing is staged from them.

## DATA-11 — An unstated currency is a question, never a dollar sign

A price with no currency on it is not a USD price. No extractor, parser or
writer may default a missing currency to USD. The number is withheld from
publication, the row is flagged for review with the figure quoted in its note,
and an operator confirms the currency with the supplier before it becomes a
price.

**Enforcement:** Guard — `normalizeToUsd` in `src/lib/fx.ts` returns status
`unknown` for a blank currency, which `insertStagedQuotes` stores as a null
price with a needs-review note, and which the lead headline mirror in
`src/lib/tenkara-inbound.ts` refuses to publish. Parsers return null rather
than a default.

## DATA-12 — The same company held twice is surfaced, never merged

A client's supplier list carries the same company under several names ("BASF",
"BASF SE", "H&amp;D PLASTICS" and "H&D PLASTICS"). Those are named on the
supplier, with the sibling names and who owns each, so an operator can judge
them. They are never merged automatically: two names can be one company or two
genuinely different firms, suppliers are per client (SUP-01), and merging is a
human call.

Separately, a marketplace version and a direct version of one company are NOT
duplicates. They are deliberate, they price differently and by the assignment
rules they usually carry different operators. Each one names the other so
neither is negotiated blind, and nothing about the split changes.

**Enforcement:** Guard — `findSupplierDupeSuspicions` and
`findCrossLaneVersions` in `src/lib/supplier-dupe-suspicion.ts`, rendered on the
per-client Suppliers tab. Both return labels only; neither writes.

## DATA-13 — An operator's correction re-anchors a price, it does not freeze it

When an operator corrects a price, their number becomes the anchor everything
downstream works from: it is stored as the capture-time figure, converted back
into the supplier's currency, and marked as operator-set. The daily currency
refresh keeps restating it at today's rate, because a frozen price goes stale.
What it may never do is keep recalculating from the supplier-currency figure the
operator just contradicted, which silently reverted their edit the same night.

A correction is also the only reliable signal that an extraction was wrong, and
the same misread usually hit every other quote from that message. Those rows go
back to review naming what changed. They are never rewritten: a price only moves
when a human moves it. A later quote from the same supplier for the same
material still lands as its own row, carrying a note that an operator already
ruled on this price.

**Enforcement:** Guard — `updateStagedQuote` in
`src/app/actions/staged-quotes.ts` re-anchors and flags siblings;
`operatorSet` in `src/lib/staged-quotes.ts` notes the later quote.

## DATA-14 — A captured price carries the words it was read from

Every staged price stores the verbatim fragment of the supplier's own message
it came from, and the row has to reconcile against it: `price / case_size`,
converted, must equal a rate the fragment states. A number that does not
reconcile was computed, not captured, and a computed number is withheld under
DATA-01.

This is the positive form of "do not do arithmetic on a quote". The prompt
already forbids DIVIDING a price by a pack size; it said nothing about reading
the basis off the wrong line, so Yujiang's "EXW price: USD1015/MT; Packing:
180KGS/Drum" was stored as 1015 against a 180 kg case — $5.64/kg for a material
quoted at $1.015/kg, 5.6x too expensive, stamped `confidence: high`. No
blocklist would have caught it. The arithmetic does, and catches every future
variant, because a wrong basis cannot reproduce the supplier's own rate.

Check the arithmetic, never the wording. The first version of this guard
compared the unit WORD and required the stored amount to appear literally in the
fragment. Both premises were wrong for this schema, where `price` is the price
of a CASE: three correct rows quoting "USD 1,280/MT" against a 1000 kg case were
rejected for saying kg where the supplier said MT — the same offer in different
words — and a correctly derived case price (518 lb at 1.1975/lb is 620.31) is a
number the supplier never wrote. A guard that withholds correct prices trains
operators to override it.

The same fragment is what lets anyone audit the table without re-reading the
mailbox. Reconciling 49 rows for one client against the original threads took a
full session precisely because no row said where its number came from — and the
first pass through them was itself wrong, reading case prices as per-unit
prices, which is how four correct rows came to be reported as defects.

**Enforcement:** Guard — `price/capture-must-carry-source-text`:
`verifyPriceProvenance` in `src/lib/price-provenance.ts` is applied by
`insertStagedQuotes` before the publish gate and again on the lead-headline
mirror in `src/lib/tenkara-inbound.ts`; a price it cannot trace is stored as
null with the reason and `needs_review`. The check also holds the two
extractors to asking for the fragment, and holds `staged_quotes` to a
`price_source_text` column (migration 0124).

## DATA-15 — Extraction records what it did not take

Every inbound supplier message gets a durable record of how many price points
it contained and how many were staged, and a shortfall raises. Counting only
the rows we wrote measures the extractor with itself.

A zero-row alarm is not enough. `quote_capture_silent` (DATA-10) fires when a
run stages nothing at all, which catches an outage and nothing smaller. The
common failure is partial: Foodchem sent three prices in one thread — 1.49,
then a revision to 1.53 FOB and 1.81 CIF — and one was staged, so the message
looked like a clean capture and the client's live figure was the superseded
one. Reroot quoted two materials and one was kept. Separately, three suppliers
whose entire quote was a plain `usd1300/mt` produced no row and no trace, so
nothing anywhere recorded that we had read their reply and taken nothing from
it.

The count is the alarm, not the presence of a row. A miss must leave a mark, or
the miss rate is unknowable and no later fix can be shown to have worked.

**Enforcement:** Audit — `agent-24-price-capture-reconcile`. Every inbound
message writes `message_price_capture` (migration 0125) with the price points
the extractor counted before extracting and the rows actually accounted for;
Agent 24 re-reads the shortfalls daily and alerts on the confirmed ones. Per
META-07 the second read is a model read, never a price regex, and it reports
rather than stages — the first read already got that message wrong once.

## DATA-16 — Every rung of a tiered quote is its own row

A supplier's price ladder is captured rung by rung and rungs are never merged.
Two rungs are distinguished by their basis — the quantity the price applies to
— so a rung whose basis could not be read must be held for review, never folded
into a sibling that happens to share its amount.

Currently sound and recorded to keep it that way: ladders survive today (one
client holds intact ladders of four, four and three rungs, matching the source
emails, with zero collisions fleet-wide). The exposure is structural rather
than live. The extractor is instructed to null `case_size` whenever the basis
is ambiguous, and `case_size` is part of the conversation echo key in
`insertStagedQuotes`, so two rungs that both lose their basis become
indistinguishable and the second is dropped as an echo. Five priced rows
fleet-wide carry a null basis today.

A price band or outlier check must also compare a rung against other suppliers'
quotes for the same material, never against its own siblings: a ladder is
supposed to span a range, and treating that spread as an anomaly would flag
every correctly captured ladder.

**Enforcement:** Guard — `price/tier-rungs-never-collapse`: `dupKey`, `echoKey`
and `pricelessKey` in `src/lib/staged-quotes.ts` fall back to
`provenanceKey(price_source_text)` when there is no basis to tell two rungs
apart, so rungs separate on the words they were read from. The check holds all
three keys to it.

## DATA-17 — A later source fills a blank, it does not overwrite a checked value

Several writers describe the same supplier: the website pull, the enrichment
fill, the web fill, an operator, and the supplier itself in a reply. They do not
rank equally. A blank is anyone's to fill. A value a person has already looked
at is not, and the marker for that is the profile leaving `draft`, which is
exactly what the fill pass and the web fill already stop on.

The inbound reply handler was the exception. It wrote all eight contact,
shipping and billing columns unconditionally, so an address a supplier mentioned
in passing replaced the one ops had entered: 5,199 reviewed profiles holding a
contact email were open to it on 2026-08-20.

A replacement that is declined is recorded, never dropped in silence, and the
supplier's own words remain in the thread either way. The same asymmetry governs
the market kind: a lead that captured the seller's own address is direct, and no
later recheck of the listing may flip it back.

**Enforcement:** Guard — `applySupplierStatedDetails` in
`src/lib/supplier-profiles.ts`, the only path the reply handler writes a profile
through; the direct-contact exception is carried by both `site_type` writes in
`src/agents-runtime/agents/marketplace-validation/lead-price-pull.ts`.
