import Anthropic from "@anthropic-ai/sdk";
import type { DocType } from "@/lib/supplier-documents";

// Parse key fields out of a supplier qualification document (CoA, certificate,
// SDS, statement, ...). Counterpart to attachment-parser.ts, which extracts
// PRICING; this extracts qualification content. Read-only, best-effort: any
// failure returns null so the inbound webhook is never blocked.

const MODEL = "claude-sonnet-4-5";
const MAX_BYTES = 8 * 1024 * 1024;

export interface ExtractedDocFields {
  expires_on: string | null; // YYYY-MM-DD retest/expiry/valid-until, when stated
  fields: Record<string, any>; // doc-type-specific extras
}

// The fields we ask for per document type. Kept small and concrete so the model
// returns high-signal data and leaves the rest null rather than inventing.
const FIELD_HINTS: Record<DocType, string> = {
  coa: `"lot_number", "material_name", "grade", "assay_percent" (numeric purity/assay, else null), "manufacture_date" (YYYY-MM-DD), "retest_or_expiry_date" (YYYY-MM-DD)`,
  certificate: `"certificate_type" (e.g. ISO 9001, GMP, Kosher, Halal, Organic), "issuer", "certificate_number", "valid_from" (YYYY-MM-DD), "valid_until" (YYYY-MM-DD)`,
  sds: `"product_name", "manufacturer", "cas_number", "revision_date" (YYYY-MM-DD), "hazard_summary"`,
  tds: `"product_name", "grade", "key_specs" (short string of the headline specs)`,
  statement: `"statement_type" (e.g. allergen, non-GMO, Prop 65, vegan), "summary" (one line of what it states)`,
  testing: `"test_type", "result_summary", "pass_fail"`,
  price_sheet: `"note"`,
  other: `"summary" (one line describing the document)`,
};

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function imageMediaType(ext: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return null;
  }
}

// Content-extractable formats. Excludes spreadsheets — CoAs/certs are PDFs,
// images, or text, not xlsx.
export function isDocExtractableExt(ext: string): boolean {
  const e = ext.toLowerCase();
  return e === "pdf" || e === "txt" || e === "csv" || !!imageMediaType(e);
}

function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeDate(v: any): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? v.trim() : null;
}

// Parse the document bytes into structured fields. Returns null on any failure
// (missing key, unsupported type, API/parse error) — content extraction must
// never break inbound handling.
export async function extractDocumentFields(
  buf: Buffer,
  docType: DocType,
  ext: string
): Promise<ExtractedDocFields | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (buf.byteLength > MAX_BYTES) return null;
  const e = ext.toLowerCase();
  if (!isDocExtractableExt(e)) return null;

  try {
    let contentBlock: Anthropic.ContentBlockParam;
    if (e === "pdf") {
      contentBlock = { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
    } else if (imageMediaType(e)) {
      contentBlock = { type: "image", source: { type: "base64", media_type: imageMediaType(e)!, data: buf.toString("base64") } };
    } else {
      const text = buf.toString("utf-8").slice(0, 100_000);
      if (!text.trim()) return null;
      contentBlock = { type: "text", text: "Document contents:\n\n" + text };
    }

    const system = `You extract key fields from a supplier vendor-qualification document. This document is a ${docType.toUpperCase()}.

Return ONLY a JSON object (no prose):
{
  "expires_on": "YYYY-MM-DD or null",   // the retest / expiry / valid-until date if the document states one, else null
  "fields": { ${FIELD_HINTS[docType]} }
}

Rules:
- Extract ONLY what the document actually states. Use null for anything not present. NEVER guess or infer.
- Dates must be YYYY-MM-DD or null.
- Numbers must be numeric (strip units/symbols) or null.
- expires_on is the single most relevant validity/retest/expiry date on the document.`;

    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: "Extract the fields as JSON." }] }],
    });
    const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      expires_on: normalizeDate(parsed.expires_on),
      fields: parsed.fields && typeof parsed.fields === "object" ? parsed.fields : {},
    };
  } catch {
    return null;
  }
}
