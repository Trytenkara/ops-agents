import { verifyPriceProvenance as v } from "../src/lib/price-provenance";
const cases: Array<[string, any, boolean]> = [
  // --- the five real defects: all must FAIL
  ["Katonah fabricated (518 x 1.1975)", {price:620.5410, unitOfMeasurement:"lb", sourceText:"Drums are 518lbs at 1.1975/lb"}, false],
  ["Chemger per-tonne labelled kg",     {price:1280, unitOfMeasurement:"kg", sourceText:"the price is usd1280/mt FOB Qingdao"}, false],
  ["Sinochem mt mislabel w/ kg nearby", {price:1450, unitOfMeasurement:"kg", sourceText:"Price: USD1450/MT FCA QINGDAO port, 215kg/drum"}, false],
  ["Yujiang mt as kg",                  {price:1015, unitOfMeasurement:"kg", sourceText:"USD 1015 per metric ton CIF"}, false],
  ["no source text at all",             {price:99, unitOfMeasurement:"kg", sourceText:null}, false],
  // --- real correct captures: all must PASS
  ["Katonah real price",        {price:1.1975, unitOfMeasurement:"lb", sourceText:"Drums are 518lbs at 1.1975/lb"}, true],
  ["Depu correct mt",           {price:1300, unitOfMeasurement:"MT", sourceText:"Today our best offer is FOBQingdaousd1300/mt for USP grade"}, true],
  ["Sinochem correct mt",       {price:1450, unitOfMeasurement:"MT", sourceText:"Price: USD1450/MT FCA QINGDAO port, 215kg/drum"}, true],
  ["Foodchem per kg",           {price:1.53, unitOfMeasurement:"kg", sourceText:"revised price USD 1.53/kg FOB"}, true],
  ["thousands separator",       {price:2900, unitOfMeasurement:"MT", sourceText:"USD 2,900.00 per tonne"}, true],
  ["trailing zeros",            {price:1.2, unitOfMeasurement:"kg", sourceText:"$1.20 per kg"}, true],
  ["unit far from number",      {price:1300, unitOfMeasurement:"MT", sourceText:"we can do 1300 on that one, per tonne, delivered"}, true],
  ["kilo synonym",              {price:5.9, unitOfMeasurement:"kg", sourceText:"MCT at 5.90 per kilo"}, true],
  ["INR native pre-FX",         {price:230, unitOfMeasurement:"kg", sourceText:"Rs.230 per kg plus GST"}, true],
  ["unrecognised unit string",  {price:12, unitOfMeasurement:"pallet", sourceText:"12 per pallet"}, true],
  ["no unit claimed",           {price:4650, unitOfMeasurement:null, sourceText:"USD 4650"}, true],
  ["no price to trace",         {price:null, unitOfMeasurement:"kg", sourceText:null}, true],
  ["ladder repeats amount",     {price:2.1, unitOfMeasurement:"kg", sourceText:"500kg: 2.10/kg, 1000kg: 2.10/kg"}, true],
  ["lbs plural",                {price:0.85, unitOfMeasurement:"lb", sourceText:"0.85/lbs on 2000 lbs"}, true],
  ["'mt' must not match 'amount'", {price:500, unitOfMeasurement:"kg", sourceText:"the amount is 500 kg"}, true],
];
let bad = 0;
for (const [name, inp, want] of cases) {
  const r = v(inp);
  const ok = r.ok === want;
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(34)} got=${r.ok}${r.reason ? "  :: " + r.reason.slice(0,95) : ""}`);
}
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
// regression: abbreviation dots must not swallow the figure
for (const [t, p] of [["Rs.230 per kg plus GST",230],["Rs. 300/kg",300],["approx.1500/mt",1500],["USD .50 per kg",0.5]] as Array<[string,number]>) {
  const r = v({price:p, unitOfMeasurement:null, sourceText:t});
  console.log(`${r.ok?"ok  ":"FAIL"}  numscan ${JSON.stringify(t)} -> ${p}`);
}
