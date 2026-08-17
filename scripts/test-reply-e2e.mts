// End-to-end: real model call through composeReply, on the flagged scenario.
// Run: export ANTHROPIC_API_KEY=... && npx tsx scripts/test-reply-e2e.ts
import { composeReply } from "../src/lib/reply-drafter";
import { computeMissingApprovalFields } from "../src/lib/quote-completeness";

const missing = computeMissingApprovalFields([], null);

const draft = await composeReply({
  mode: "active",
  clientOrgName: "California Chemicals",
  supplierName: "UPI Global (UPIchem)",
  supplierContactName: "Zach",
  materialName: "Propylene Glycol USP",
  originalSubject: "SR-20260807-4525: Sourcing inquiry for Propylene Glycol USP",
  theirSubject: "Re: SR-20260807-4525: Sourcing inquiry for Propylene Glycol USP",
  theirPreview:
    "Thanks for reaching out. Attached is our quote for Propylene Glycol USP and our product line sheets. Happy to discuss volumes.",
  receivedAttachments: [{ name: "UPI-quote-PG-USP.pdf", pricingExtracted: true }],
  missingApprovalFields: missing,
} as any);

console.log("Subject:", draft.subject);
console.log("\n--- BODY ---\n");
console.log(draft.body);
console.log("\n--- CHECKS ---");
const body: string = draft.body ?? "";
const askPara = (body.match(/To complete our review[^?]*\?/) ?? [""])[0];
console.log(`Backstop paragraph present: ${askPara ? "yes" : "no"}`);
if (askPara) {
  const items = askPara.split(/,| and /).filter((s) => s.trim()).length;
  console.log(`Backstop length: ${askPara.length} chars, ~${items} clauses`);
  console.log(askPara.length < 200 ? "PASS  backstop is short, not a field dump" : "FAIL  backstop is still a field dump");
}
console.log(`Total missing fields available to ask: ${missing.length}`);
console.log(`Body word count: ${body.split(/\s+/).length}`);
