// The stalled-conversation nudge must restate the CURRENT stage's outstanding
// items, not a generic "did you see my note" and not the whole missing set.
// Run: npx tsx scripts/test-stalled-nudge-asks.ts
import { buildStalledBody } from "../src/agents-runtime/agents/reply-manager/stalled-followup";
import { computeMissingApprovalFields, selectStagedAsks, MAX_ASKS_PER_REPLY } from "../src/lib/quote-completeness";

let failed = 0;
const check = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!pass) failed++;
};

const states = [
  { label: "stage 1, nothing captured", quote: {}, supplier: {} },
  {
    label: "stage 2, price/MOQ/lead time answered",
    quote: { price: 2.15, moq_quantity: 10, moq_unit: "drums", lead_time_days: 14 },
    supplier: {},
  },
  {
    label: "stage 3, packaging and terms answered",
    quote: {
      price: 2.15, moq_quantity: 10, moq_unit: "drums", lead_time_days: 14,
      case_size: 55, unit_of_measurement: "gal", payment_terms: "Net 30",
      dim_source: "supplier", case_type: "drum",
      raw_extract: { supplier_case_type: "drum", supplier_dimensions: { length: 24, width: 24, height: 35, unit: "in", packaging_case_weight: 520 } },
    },
    supplier: { payment_upfront_pct: 0, shipping_terms: "EXW" },
  },
];

for (const [i, s] of states.entries()) {
  const missing = computeMissingApprovalFields([s.quote as any], s.supplier as any);
  const { stage, ask } = selectStagedAsks("", missing);
  const body = buildStalledBody({
    contactName: "Zach Miller",
    material: "Propylene Glycol USP",
    signoff: "California Chemicals Purchasing Team",
    n: 1,
    outstanding: ask.map((f) => f.clause),
  });
  console.log("=".repeat(70));
  console.log(`nudge #1 | ${s.label} | stage ${stage}`);
  console.log("-".repeat(70));
  console.log(body);
  console.log();
  check(`stage ${i + 1}: names what we are waiting for`, /we still need/i.test(body));
  check(`stage ${i + 1}: at most ${MAX_ASKS_PER_REPLY} items`, ask.length <= MAX_ASKS_PER_REPLY, `${ask.length}`);
  check(`stage ${i + 1}: no field dump`, body.length < 500, `${body.length} chars`);
  check(`stage ${i + 1}: no em dash`, !body.includes("—"));
}

// Quote already complete: the nudge must stay generic, not invent an ask.
const done = buildStalledBody({
  contactName: "Zach",
  material: "Propylene Glycol USP",
  signoff: "California Chemicals Purchasing Team",
  n: 2,
  outstanding: [],
});
console.log("=".repeat(70));
console.log("nudge #2 | nothing outstanding");
console.log("-".repeat(70));
console.log(done);
check("complete quote: no invented ask", !/we still need/i.test(done));

console.log(`\n${failed === 0 ? "ALL ASSERTIONS PASSED" : `${failed} ASSERTION(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
