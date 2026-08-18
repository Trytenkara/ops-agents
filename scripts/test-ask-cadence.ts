// Walks one supplier through the 3-stage ask cadence and asserts no email asks
// for a later stage's fields. Run: npx tsx scripts/test-ask-cadence.ts
import {
  buildCompletenessAsk,
  computeMissingApprovalFields,
  selectStagedAsks,
  countAsksInBody,
  askStage,
  MAX_ASKS_PER_REPLY,
  type StagedQuoteFieldState,
  type SupplierApprovalState,
} from "../src/lib/quote-completeness";

let failed = 0;
const check = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!pass) failed++;
};

// Supplier state after each round of answers, cumulative.
const rounds: { label: string; quote: StagedQuoteFieldState; supplier: SupplierApprovalState }[] = [
  { label: "nothing captured yet", quote: {}, supplier: {} },
  {
    label: "they gave price, MOQ, lead time",
    quote: { price: 2.15, moq_quantity: 10, moq_unit: "drums", lead_time_days: 14 },
    supplier: {},
  },
  {
    label: "they gave packaging and terms",
    quote: {
      price: 2.15, moq_quantity: 10, moq_unit: "drums", lead_time_days: 14,
      case_size: 55, unit_of_measurement: "gal", payment_terms: "Net 30",
      dim_source: "supplier", case_type: "drum",
      raw_extract: { supplier_case_type: "drum", supplier_dimensions: { length: 24, width: 24, height: 35, unit: "in", packaging_case_weight: 520 } },
    },
    supplier: { payment_upfront_pct: 0, shipping_terms: "EXW" },
  },
];

console.log("=== STAGE WALK ===\n");
const seen: string[] = [];
for (const [i, r] of rounds.entries()) {
  const missing = computeMissingApprovalFields([r.quote], r.supplier);
  const { stage, ask, deferred } = selectStagedAsks("", missing);
  const sentence = buildCompletenessAsk(ask);
  console.log(`--- Email ${i + 1} (${r.label})`);
  console.log(`stage ${stage} | asking ${ask.length} | still outstanding ${deferred.length}`);
  console.log(sentence || "(nothing left to ask)");
  console.log();

  check(`email ${i + 1}: at most ${MAX_ASKS_PER_REPLY} asks`, ask.length <= MAX_ASKS_PER_REPLY, `${ask.length}`);
  check(`email ${i + 1}: all asks are the same stage`, new Set(ask.map((f) => askStage(f.key))).size <= 1);
  check(`email ${i + 1}: reaches stage ${i + 1}`, stage === i + 1, `got ${stage}`);
  for (const f of ask) {
    check(`email ${i + 1}: does not re-ask "${f.key}"`, !seen.includes(f.key));
  }
  seen.push(...ask.map((f) => f.key));
}

// Stage 3 must never be reached while commercial basics are still blank.
const cold = computeMissingApprovalFields([], null);
const coldPick = selectStagedAsks("", cold);
check("no contact details asked before pricing exists", coldPick.ask.every((f) => askStage(f.key) === 1));
const dimsOnly = selectStagedAsks("", cold.filter((f) => ["case_length", "case_width", "case_height", "dimensions_unit"].includes(f.key))).ask;
check("dimensions collapse to one ask", dimsOnly.length === 1 && dimsOnly[0].key === "case_dimensions", dimsOnly.map((f) => f.key).join(","));
const pocOnly = selectStagedAsks("", cold.filter((f) => ["poc_name", "poc_email", "poc_phone"].includes(f.key))).ask;
check("sales contact collapses to one ask", pocOnly.length === 1 && pocOnly[0].key === "poc_contact", pocOnly.map((f) => f.key).join(","));

console.log("\n=== APPENDED-PARAGRAPH SUPPRESSION ===");
const chatty = `Hi Zach,\n\nThanks for the quote.\n\nCould you confirm (1) the MOQ for the drum option, (2) whether a deposit is required, and (3) your EXW price?\n\nCalifornia Chemicals Purchasing Team`;
const quiet = `Hi Zach,\n\nThanks for the quote, we're reviewing it now and will come back to you shortly.\n\nCalifornia Chemicals Purchasing Team`;
check("email that already asks -> paragraph suppressed", countAsksInBody(chatty) > 0, `${countAsksInBody(chatty)} asks counted`);
check("email that asks nothing -> paragraph appended", countAsksInBody(quiet) === 0, `${countAsksInBody(quiet)} asks counted`);

console.log(`\n${failed === 0 ? "ALL ASSERTIONS PASSED" : `${failed} ASSERTION(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
