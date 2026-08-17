// End-to-end, real model calls: the same supplier across all 3 ask stages.
// Run: export ANTHROPIC_API_KEY=... && npx tsx scripts/test-cadence-e2e.mts
import { composeReply } from "../src/lib/reply-drafter";
import { computeMissingApprovalFields, countAsksInBody, selectStagedAsks } from "../src/lib/quote-completeness";

const base = {
  mode: "active",
  clientOrgName: "California Chemicals",
  supplierName: "UPI Global (UPIchem)",
  supplierContactName: "Zach",
  materialName: "Propylene Glycol USP",
  originalSubject: "SR-20260807-4525: Sourcing inquiry for Propylene Glycol USP",
  theirSubject: "Re: SR-20260807-4525: Sourcing inquiry for Propylene Glycol USP",
};

const rounds = [
  {
    label: "Email 1 - they sent a quote PDF, nothing captured yet",
    theirPreview: "Thanks for reaching out. Attached is our quote for Propylene Glycol USP and our product line sheets. Happy to discuss volumes.",
    receivedAttachments: [{ name: "UPI-quote-PG-USP.pdf", pricingExtracted: true }],
    quote: {},
    supplier: {},
  },
  {
    label: "Email 2 - they answered price, MOQ, lead time",
    theirPreview: "Our price is $2.15/lb, MOQ is 10 drums, and lead time is about 2 weeks from order.",
    receivedAttachments: [],
    quote: { price: 2.15, moq_quantity: 10, moq_unit: "drums", lead_time_days: 14 },
    supplier: {},
  },
  {
    label: "Email 3 - they answered packaging and terms",
    theirPreview: "We ship in 55 gallon drums, 24x24x35 inches, 520 lb gross. Payment is Net 30, no deposit. EXW Mebane, NC.",
    receivedAttachments: [],
    quote: {
      price: 2.15, moq_quantity: 10, moq_unit: "drums", lead_time_days: 14,
      case_size: 55, unit_of_measurement: "gal", payment_terms: "Net 30",
      dim_source: "supplier", case_type: "drum",
      raw_extract: { supplier_case_type: "drum", supplier_dimensions: { length: 24, width: 24, height: 35, unit: "in", packaging_case_weight: 520 } },
    },
    supplier: { payment_upfront_pct: 0, shipping_terms: "EXW" },
  },
];

let failed = 0;
for (const r of rounds) {
  const missing = computeMissingApprovalFields([r.quote as any], r.supplier as any);
  const { stage, ask } = selectStagedAsks("", missing);
  const draft = await composeReply({ ...base, ...r, missingApprovalFields: missing } as any);
  const body: string = draft.body ?? "";
  console.log("=".repeat(72));
  console.log(`${r.label}   [stage ${stage}, allowed to ask: ${ask.map((f) => f.key).join(", ")}]`);
  console.log("-".repeat(72));
  console.log(body);
  console.log("-".repeat(72));
  const n = countAsksInBody(body);
  const dump = /To complete our review[^?]{200,}\?/.test(body);
  const twoLists = (body.match(/To complete our review/g) ?? []).length > 0 && n > 3;
  console.log(`asks in email: ${n}   field-dump paragraph: ${dump ? "YES" : "no"}   second list: ${twoLists ? "YES" : "no"}`);
  if (n > 4) { console.log("FAIL  too many asks in one email"); failed++; }
  if (dump) { console.log("FAIL  field dump present"); failed++; }
  console.log();
}
console.log(failed === 0 ? "ALL ROUNDS PASSED" : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
