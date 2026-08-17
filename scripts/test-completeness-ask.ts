// Reproduces the ops-flagged draft (Mildred, 2026-08-15): the reply backstop
// appended every missing field in one sentence, re-asking things the model's own
// copy had already asked for. Run: npx tsx scripts/test-completeness-ask.ts
import {
  buildCompletenessAsk,
  computeMissingApprovalFields,
  selectCompletenessAsks,
  MAX_ASKS_PER_REPLY,
} from "../src/lib/quote-completeness";
import { insertBeforeSignoff } from "../src/lib/reply-drafter";

// The model's own copy, transcribed from the flagged UPI Global draft.
const MODEL_BODY = `Hi Zach,

Thank you for the quote and the product line sheets, we've received them and are reviewing your offering.

To complete our evaluation of the Propylene Glycol USP, could you provide:
- MOQ and typical lead time
- Outer case dimensions (L x W x H) and gross case weight
- Standard payment terms and any upfront deposit requirement
- Your EXW price at your Mebane, NC facility (since we can arrange freight to Chino, CA 91710)

We'll circle back once we've reviewed your catalogs for other materials we might source through you.

Thanks,
California Chemicals Purchasing Team`;

// Nothing captured yet on our side, which is what produced the full field dump.
const missing = computeMissingApprovalFields([], null);

console.log(`Missing fields computed: ${missing.length}`);
console.log(`Cap per reply: ${MAX_ASKS_PER_REPLY}\n`);

console.log("=== BEFORE (old backstop: buildCompletenessAsk over ALL missing) ===");
const before = buildCompletenessAsk(missing);
console.log(before);
console.log(`\n[chars: ${before.length}, fields asked: ${missing.length}]\n`);

console.log("=== AFTER (selectCompletenessAsks: drop covered, then cap) ===");
const { ask, deferred } = selectCompletenessAsks(MODEL_BODY, missing);
const after = buildCompletenessAsk(ask);
console.log(after || "(nothing to append)");
console.log(`\n[chars: ${after.length}, fields asked: ${ask.length}, deferred to next reply: ${deferred.length}]\n`);

console.log("=== ASSERTIONS ===");
let failed = 0;
const check = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!pass) failed++;
};

check("asks are capped", ask.length <= MAX_ASKS_PER_REPLY, `${ask.length} <= ${MAX_ASKS_PER_REPLY}`);
check("fewer asks than before", ask.length < missing.length, `${ask.length} < ${missing.length}`);

// The four things the model already asked for must not be re-asked.
const alreadyCovered = ["moq", "lead_time", "case_weight", "payment_terms", "payment_upfront_pct", "price"];
for (const key of alreadyCovered) {
  const reAsked = ask.some((f) => f.key === key);
  check(`does not re-ask "${key}"`, !reAsked);
}

// Nothing is silently lost: every uncovered field is either asked or deferred.
const uncoveredTotal = ask.length + deferred.length;
const covered = missing.length - uncoveredTotal;
check("no field vanishes", uncoveredTotal + covered === missing.length, `${ask.length} asked + ${deferred.length} deferred + ${covered} covered = ${missing.length}`);

// The ask must land as its own paragraph ABOVE the whole sign-off block, whatever
// closing the model chose. It used to wedge itself between "Best regards," and the
// org name because the lead-in regex matched "best" and "regards" separately.
console.log("\n=== SIGN-OFF PLACEMENT ===");
const ORG = "California Chemicals Purchasing Team";
const ASK = "To complete our review, could you also share pack or case size and unit?";
const closings = ["Thanks,", "Best regards,", "Kind regards,", "Sincerely,", "Cheers,", ""];
for (const closing of closings) {
  const body = `Hi Zach,\n\nThanks for the quote.\n\nLooking forward to your response.\n\n${closing ? closing + "\n\n" : ""}${ORG}`;
  const out = insertBeforeSignoff(body, ASK, ORG);
  const askAt = out.indexOf(ASK);
  const closingAt = closing ? out.indexOf(closing) : Infinity;
  const orgAt = out.indexOf(ORG);
  const ordered = askAt < closingAt && askAt < orgAt;
  const closingKept = closing ? out.includes(closing) : true;
  check(`ask precedes "${closing || "(no closing)"}" + org`, ordered && closingKept, closingKept ? "" : "closing was dropped");
}

console.log(`\n${failed === 0 ? "ALL ASSERTIONS PASSED" : `${failed} ASSERTION(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
