// One-off backfill: fill staged_quotes.incoterm / incoterm_location on quotes
// that were staged before the column existed (migration 0118).
//
// The term was never lost, just unstructured — the extractors wrote it into the
// free-text notes ("FOB Anaheim", "EXW Xian; pickup available from China
// factory", "CIF by sea"), where nothing can compare two suppliers on it. This
// re-reads each row's own captured record with the model and lifts the term into
// the column. It is a READ of what the supplier already sent, not an inference:
// a row whose record names no term stays null.
//
// Usage: node scripts/backfill-staged-quote-incoterm.mjs [--apply]
//        (dry run by default)

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

const env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
const fromEnvFile = (k) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : null;
};
const KEY = process.env.OA_SUPABASE_SERVICE_ROLE_KEY || fromEnvFile("OA_SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || fromEnvFile("ANTHROPIC_API_KEY");
const BASE = "https://aiyzpjnvenfmurhyamge.supabase.co/rest/v1";
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const apply = process.argv.includes("--apply");
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

const SYSTEM = `You read one stored supplier price quote and report the delivery term (Incoterm) the supplier stated for it.

Return ONLY JSON: {"incoterm": "FOB" | null, "incoterm_location": "Shanghai" | null, "evidence": "the words you read it from, or null"}

Rules:
- incoterm is a bare Incoterms code in caps: EXW, FCA, FAS, FOB, CFR, CIF, CPT, CIP, DAP, DPU, DDP.
- Map the supplier's phrasing: "ex factory"/"ex works"/"ex-works" is EXW, "C&F" is CFR, "delivered duty paid" is DDP, "free on board" is FOB.
- incoterm_location is the named place attached to the term ("FOB Shanghai" gives "Shanghai"). Null for a bare term ("CIF by sea" has no named place).
- Return null for BOTH fields unless the record actually names a term. Do NOT infer one from the country, the price level, a port, a shipping mode, or a delivery sentence that names no term. A wrong term makes an incomparable price look comparable, so a blank is the correct answer whenever you are unsure.
- evidence must be the exact substring you read the term from, else null.`;

async function get(path) {
  const r = await fetch(`${BASE}/${path}`, { headers });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

async function patch(id, body) {
  const r = await fetch(`${BASE}/staged_quotes?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
}

async function readTerm(row) {
  const record = {
    supplier_name: row.supplier_name,
    material_name: row.material_name,
    price: row.price,
    currency: row.currency,
    unit_of_measurement: row.unit_of_measurement,
    extraction_notes: row.extraction_notes,
    raw_extract: row.raw_extract,
  };
  const res = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 300,
    system: SYSTEM,
    messages: [{ role: "user", content: `Stored quote record:\n\n${JSON.stringify(record).slice(0, 12000)}` }],
  });
  const text = res.content.find((b) => b.type === "text")?.text ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { incoterm: null, incoterm_location: null, evidence: null };
  try {
    const p = JSON.parse(text.slice(start, end + 1));
    const code = typeof p.incoterm === "string" ? p.incoterm.trim().toUpperCase() || null : null;
    return {
      incoterm: code,
      incoterm_location: typeof p.incoterm_location === "string" ? p.incoterm_location.trim() || null : null,
      evidence: typeof p.evidence === "string" ? p.evidence.trim() || null : null,
    };
  } catch {
    return { incoterm: null, incoterm_location: null, evidence: null };
  }
}

const rows = await get(
  "staged_quotes?incoterm=is.null&select=id,supplier_name,material_name,price,currency,unit_of_measurement,extraction_notes,raw_extract,created_at&order=created_at.desc"
);
console.log(`${rows.length} staged quotes with no incoterm${apply ? "" : " (dry run)"}`);

let found = 0;
for (const row of rows) {
  const t = await readTerm(row);
  if (!t.incoterm) continue;
  found++;
  console.log(
    `${t.incoterm}${t.incoterm_location ? " " + t.incoterm_location : ""}  ${row.supplier_name ?? "—"} / ${row.material_name ?? "—"}  <- ${t.evidence ?? ""}`
  );
  if (apply) await patch(row.id, { incoterm: t.incoterm, incoterm_location: t.incoterm_location });
}
console.log(`${found} of ${rows.length} rows carried a stated term${apply ? " (written)" : " (dry run, nothing written)"}`);
