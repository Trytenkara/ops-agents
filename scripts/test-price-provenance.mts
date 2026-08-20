// DATA-14 guard. Each case is [name, price, caseSize, unit, supplier's words, should pass].
//
// `price` is the price of a CASE and `caseSize` is how many `unit` are in it, so
// the row's per-unit price is price/caseSize. The guard passes when that agrees
// with a rate the supplier actually wrote, once the two units are converted to
// common ground. The named CalChem cases are real rows read back against the
// real email.
import { verifyPriceProvenance as v } from "../src/lib/price-provenance";

type Case = [string, number | null, number | null, string | null, string, boolean];

const cases: Case[] = [
  // --- real rows that are CORRECT and must not be withheld. Every one of these
  // was rejected by the first version of this guard, which compared the unit
  // WORD: the supplier writes /MT, the row counts kg, same offer.
  ["Chemger 1280 per 1000kg case", 1280, 1000, "kg", "Price: USD 1,280/MT FOB Qingdao, China", true],
  ["Andy 1335 per 1000kg case", 1335, 1000, "kg", "USP Propylene glycol 99.7%min USD1335/MT,FOB Qingdao port", true],
  ["Yny 2900 per 1000kg case", 2900, 1000, "kg", "Price : USD 2900/MT EXW Qingdao port (Incoterms2020) Packing: 200L HDPE drums,180kgs/drum", true],
  // 620.541/518 is 1.19795/lb against a quoted 1.1975 — 0.04%, the supplier's
  // own rounding. This is why the tolerance is 1% and not exact equality.
  ["Katonah 620.541 per 518lb drum", 620.541, 518, "lb", "Drums are 518lbs at 1.1975/lb", true],
  ["Foodchem 1.49 per kg", 1.49, 1, "kg", "Propylene Glycol 25800kg USD 1.49kg", true],
  ["Reroot 5.90 per kg", 5.9, 1, "kg", "We can offer this product at $5.90 USD/kg, FOB Mundra", true],
  ["Depu 1300 per tonne case", 1300, 1000, "kg", "Today our best offer is FOBQingdaousd1300/mt for USP grade", true],
  ["row counted in MT directly", 1450, 1, "MT", "Price: USD1450/MT FCA QINGDAO port, 215kg/drum", true],

  // --- the one real defect. 1015 was a per-tonne price; the basis was read off
  // the packing line, making the material 5.6x too expensive.
  ["Yujiang per-tonne price on a 180kg drum", 1015, 180, "kg", "EXW price: USD1015/MT; Packing: 180KGS/Drum", false],

  // --- basis and fabrication errors that must still be caught
  ["amount the supplier never wrote", 999, 1, "kg", "we can offer 4.20 per kg", false],
  ["per-lb quote stored per kg", 2.5, 1, "kg", "USD 2.50 per lb FOB", false],
  ["packing weight used as the basis", 250, 25, "kg", "USD 250 per MT, packed 25kg bags", false],
  ["extractor returned no source text", 10, 1, "kg", "", false],
  ["gallon quote against a 10L case", 37.85, 10, "l", "USD 37.85 per gallon", false],

  // --- must not false-positive
  ["fragment names no unit at all", 4.53, 1, "lb", "we can do $4.53 on that one", true],
  ["nothing to trace", null, 1, "kg", "", true],
  ["no basis, amount is in the words", 1.85, null, "kg", "Pricing: 1.85 USD/kg, FOB Mundra", true],
  ["tonne spelled out", 1450, 1000, "kg", "USD 1450 per metric ton FCA", true],
  ["gallon converted honestly", 37.85, 3.785411784, "l", "USD 37.85 per gallon", true],
  ["unit string we do not recognise", 12, null, "pallet", "12 per pallet", true],
  ["ladder rung repeats the rate", 2.1, 1, "kg", "500kg: 2.10/kg, 1000kg: 2.10/kg", true],
  ["'mt' must not match inside 'amount'", 500, 1, "kg", "the amount is 500 kg", true],
  // Live Swadesh India data. The abbreviation dot read as a decimal point turned
  // 230 into 0.23 and withheld a correct price.
  ["Rs. abbreviation is not a decimal", 230, 1, "kg", "Rs.230 per kg ex-works", true],
];

let bad = 0;
for (const [name, price, caseSize, unitOfMeasurement, sourceText, want] of cases) {
  const r = v({ price, caseSize, unitOfMeasurement, sourceText });
  const ok = r.ok === want;
  if (!ok) bad++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${(r.ok ? "pass" : "hold").padEnd(4)}  ${name}` +
      (ok ? "" : `   EXPECTED ${want ? "pass" : "hold"}`)
  );
  if (!r.ok && !want && ok) console.log(`        reason: ${r.reason?.slice(0, 130)}`);
}

// The number scanner in isolation: an abbreviation dot must never start a figure.
for (const [text, amount] of [
  ["Rs.230 per kg plus GST", 230],
  ["Rs. 300/kg", 300],
  ["approx.1500/mt", 1500],
  ["USD .50 per kg", 0.5],
] as Array<[string, number]>) {
  const r = v({ price: amount, caseSize: null, unitOfMeasurement: null, sourceText: text });
  if (!r.ok) bad++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  numscan ${JSON.stringify(text)} -> ${amount}`);
}

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
if (bad) process.exit(1);
