import Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import JSZip from "jszip";

// Extract supplier pricing from email attachments. Pricing frequently arrives
// as a PDF quote, a scanned/photographed price sheet, or a CSV, not just inline
// reply text. Callers hand us the downloaded bytes and we pass them to Claude as
// a document/image/text block to pull structured quote lines. Read-only: this
// only produces extracted data; nothing is sent anywhere.

const MODEL = "claude-sonnet-4-5";
const MAX_OUTPUT_TOKENS = 2048;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB cap — skip giant files.

export interface ExtractedQuote {
  supplier_name: string | null;
  material_name: string | null;
  price: number | null; // per-case price, currency-stripped
  case_size: number | null; // quantity the document stated the price covers; null when unstated
  unit_price_gap_reason: string | null; // why case_size (and so unit_price) is null
  unit_of_measurement: string | null;
  currency: string | null;
  grade: string | null; // supplier-stated material grade, never guessed
  lead_time_days: number | null; // normalized to days when stated; else null
  lead_time_text: string | null; // raw stated lead time ("2-3 weeks", "ARO")
  moq_quantity: number | null; // minimum order quantity, numeric
  moq_unit: string | null; // unit the MOQ is expressed in (kg, lb, cases, ...)
  payment_terms: string | null; // "Net 30", "50% deposit", etc.
  confidence: "high" | "medium" | "low";
  notes: string | null;
}

const SYSTEM_PROMPT = `You are a B2B sourcing analyst extracting supplier price quotes from a document a supplier emailed us.

The document may be a formal quote, a price list, a spreadsheet export, or a photo of a price sheet. Pull every distinct material/price line you can find.

Return ONLY a JSON object (no prose):
{
  "quotes": [
    {
      "supplier_name": "string or null (the supplier/company issuing the quote)",
      "material_name": "string (the material/product name)",
      "price": 99.99,                 // numeric, currency symbols stripped; the price for one case/unit as listed
      "case_size": 25,                // quantity the document says the price covers; null if it never says
      "unit_price_gap_reason": null,  // why case_size is null, in one sentence; null when case_size is set
      "unit_of_measurement": "kg",    // the unit case_size is in (kg, lb, L, each, ...)
      "currency": "USD",
      "grade": "USP",                 // the material grade IF the supplier states one, else null
      "lead_time_days": 21,           // stated lead time normalized to DAYS, else null
      "lead_time_text": "2-3 weeks ARO", // the raw lead-time phrasing as written, else null
      "moq_quantity": 500,            // minimum order quantity as a number, else null
      "moq_unit": "kg",               // the unit the MOQ is in (kg, lb, cases, drums, ...), else null
      "payment_terms": "Net 30",      // stated payment terms, else null
      "confidence": "high | medium | low",
      "notes": "anything ambiguous not captured by a field above: unclear unit, etc."
    }
  ]
}

Rules:
- price must be numeric or null. Strip currency symbols and codes, commas.
- currency: the ISO 4217 code the price is listed in ("USD", "EUR", "GBP", "INR", "CNY", ...). Infer from the symbol/locale (€→EUR, £→GBP, ₹ or "Rs"/"Rs."→INR, ¥→CNY or JPY by supplier, $→USD unless clearly CAD/AUD/etc.). We convert to USD ourselves — report the currency AS LISTED, do NOT convert. CURRENCY IS HIGH-STAKES: a price reported in the wrong currency gets published as a wildly wrong USD number (₹149 shown as $149 is ~85x too high). Do NOT default to USD just because there is no symbol — many suppliers (Indian, Chinese, Pakistani, etc.) list domestic-currency prices. If you cannot positively confirm the currency, return null (better a blank than a wrong currency) and note the ambiguity.
- grade: only populate if the document EXPLICITLY names a grade/spec for the material (e.g. "USP", "EP", "Food grade", "Industrial", "SCI 80"). NEVER infer or guess a "typical" grade — if it isn't stated, return null.
- lead_time_days: only when a lead/delivery time is stated. Normalize to days (1 week = 7, "2-3 weeks" = 21 using the upper bound, "1 month" = 30). Keep the exact wording in lead_time_text. Both null if not stated. NEVER guess.
- moq_quantity / moq_unit: the stated minimum order quantity and its unit. Null if not stated. Do not confuse MOQ with case_size — MOQ is the smallest total order accepted.
- payment_terms: stated payment/credit terms ("Net 30", "50% deposit", "prepaid"). Null if not stated. NEVER assume.
- These per-supplier fields (lead_time_*, moq_*, payment_terms) usually apply document-wide — repeat them on each quote line unless the document differentiates.
- case_size is the quantity THE PRICE APPLIES TO, and only the document can tell you that. If the price is already per-unit, set case_size = 1 and unit_of_measurement to that unit. If a line ties the price to a quantity ("USD 250 / 25kg drum"), that quantity is case_size.
- A PACKAGING line is NOT a price basis. Quote sheets routinely list price, incoterm, and packing as independent rows; a "Packing: 25kg PP bag" line does not mean the listed price is the price of one bag. Never divide a price by a pack/packing/drum/bag spec to manufacture a per-unit figure, and never treat MOQ, a container size, or a tier threshold as the basis.
- When the document does not state what quantity the price covers: set case_size = null, keep price exactly as listed, and write unit_price_gap_reason explaining the ambiguity in one operator-readable sentence. A blank per-unit price is correct here; a guessed one gets published as a real number.
- unit_price_gap_reason must be null whenever case_size is populated.
- Sanity-check yourself: if your line implies a per-unit price that is wildly out of line with the same document's other lines or with the same supplier's stated per-unit price, you have almost certainly picked the wrong basis. Set case_size = null and explain instead.
- If the document identifies itself as a sample, template, specimen, or dummy quotation, set confidence "low" and say so in notes. It is not a real quote.
- Capture EVERY pack size and EVERY tiered price break as its OWN line. If a material is offered in multiple pack sizes (e.g. 50 lb and 55 lb), output one line per pack size. If there are volume price breaks (e.g. $X/lb at 100 lb, $Y/lb at 500 lb), output one line per break and put the quantity threshold in notes (e.g. "tier: >=500 lb"). This is how available pack sizes per material get recorded.
- confidence "low" when the unit/case size is guessed or the figure might be an MOQ/sample price rather than a real quote.
- Never invent materials, pack sizes, or prices. If the document has no extractable price lines, return {"quotes": []}.`;

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

const PRICE_EXT = ["pdf", "csv", "png", "jpg", "jpeg", "webp", "gif", "tsv", "txt", "xlsx", "xlsm", "docx"];

// True when this file extension is one we can extract pricing from within the
// size cap. xlsx/xlsm are converted to CSV text before going to Claude (see
// workbookToText); docx is unzipped to plain text (see docxToText); legacy binary
// .xls/.doc are unsupported (exceljs can't read .xls; .doc isn't Office-XML) and skipped.
export function isPricingCandidateExt(ext: string, size: number | null | undefined): boolean {
  return PRICE_EXT.includes(ext.toLowerCase()) && (size ?? 0) <= MAX_BYTES;
}

// Best-effort file extension from a filename, falling back to the MIME subtype.
export function deriveExt(filename: string | null | undefined, contentType?: string | null): string {
  const fromName = (filename ?? "").toLowerCase().match(/\.([a-z0-9]+)\s*$/)?.[1];
  if (fromName) return fromName;
  const sub = (contentType ?? "").toLowerCase().split("/")[1]?.split(";")[0]?.trim() ?? "";
  if (sub === "jpeg") return "jpg";
  return sub;
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

function cellToString(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    // exceljs wraps formulas, hyperlinks, rich text, and errors in objects.
    const v = value as any;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v.result !== "undefined") return cellToString(v.result); // formula
    if (typeof v.text === "string") return v.text; // hyperlink / rich text
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text ?? "").join("");
    if (typeof v.error === "string") return v.error;
    return "";
  }
  return String(value);
}

// Convert an xlsx/xlsm workbook into CSV text (one block per sheet) so Claude can
// read it the same way it reads a plain CSV attachment.
async function workbookToText(buf: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const sheets: string[] = [];
  wb.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      const cells = values.map((c) => {
        const s = cellToString(c as ExcelJS.CellValue);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      });
      if (cells.some((c) => c.trim() !== "")) rows.push(cells.join(","));
    });
    if (rows.length) sheets.push(`# Sheet: ${sheet.name}\n${rows.join("\n")}`);
  });
  return sheets.join("\n\n");
}

// Convert a .docx (Office Open XML) into plain text so Claude can read it the
// same way it reads a CSV/txt attachment. A .docx is a zip whose main body is
// word/document.xml; pricing usually arrives as a Word table, so we map table
// cells to tabs and rows/paragraphs to newlines before stripping the XML tags,
// which preserves enough layout for the extractor to align material↔price.
async function docxToText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file("word/document.xml");
  if (!doc) return "";
  const uncompressedSize = Number((doc as any)?._data?.uncompressedSize ?? 0);
  if (!Number.isFinite(uncompressedSize) || uncompressedSize <= 0 || uncompressedSize > 2_000_000) return "";
  const xml = await doc.async("string");
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  return withBreaks
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Parse already-downloaded attachment bytes into quote lines. Returns [] on any
// failure: a bad attachment must never break the caller.
export async function parseAttachmentBytes(
  buf: Buffer,
  filename: string | null | undefined,
  ext: string
): Promise<ExtractedQuote[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  try {
    const e = ext.toLowerCase();
    let contentBlock: Anthropic.ContentBlockParam;
    if (e === "pdf") {
      contentBlock = {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") },
      };
    } else if (imageMediaType(e)) {
      contentBlock = {
        type: "image",
        source: { type: "base64", media_type: imageMediaType(e)!, data: buf.toString("base64") },
      };
    } else if (e === "xlsx" || e === "xlsm") {
      // Excel — convert to CSV text first; Claude can't read the binary natively.
      const text = (await workbookToText(buf)).slice(0, 200_000);
      if (!text.trim()) return [];
      contentBlock = { type: "text", text: "Attachment contents (spreadsheet exported to CSV):\n\n" + text };
    } else if (e === "docx") {
      // Word — unzip to plain text; Claude can't read the binary natively.
      const text = (await docxToText(buf)).slice(0, 200_000);
      if (!text.trim()) return [];
      contentBlock = { type: "text", text: "Attachment contents (Word document exported to text):\n\n" + text };
    } else {
      // csv / tsv / txt — send as text.
      const text = buf.toString("utf-8").slice(0, 200_000);
      contentBlock = { type: "text", text: "Attachment contents:\n\n" + text };
    }

    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            contentBlock,
            { type: "text", text: `Filename: ${filename ?? "attachment"}. Extract all price quote lines as JSON.` },
          ],
        },
      ],
    });

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const parsed = extractJson(text);
    const quotes = Array.isArray(parsed?.quotes) ? parsed.quotes : [];
    return quotes
      .filter((q: any) => q && (q.material_name || q.price != null))
      .map((q: any) => ({
        supplier_name: q.supplier_name ?? null,
        material_name: q.material_name ?? null,
        price: typeof q.price === "number" ? q.price : q.price == null ? null : Number(q.price) || null,
        case_size: typeof q.case_size === "number" ? q.case_size : q.case_size == null ? null : Number(q.case_size) || null,
        unit_price_gap_reason: typeof q.unit_price_gap_reason === "string" ? q.unit_price_gap_reason.trim() || null : null,
        unit_of_measurement: q.unit_of_measurement ?? null,
        currency: q.currency ?? "USD",
        grade: q.grade ?? null,
        lead_time_days: typeof q.lead_time_days === "number" ? q.lead_time_days : q.lead_time_days == null ? null : Number(q.lead_time_days) || null,
        lead_time_text: q.lead_time_text ?? null,
        moq_quantity: typeof q.moq_quantity === "number" ? q.moq_quantity : q.moq_quantity == null ? null : Number(q.moq_quantity) || null,
        moq_unit: q.moq_unit ?? null,
        payment_terms: q.payment_terms ?? null,
        confidence: ["high", "medium", "low"].includes(q.confidence) ? q.confidence : "low",
        notes: q.notes ?? null,
      }));
  } catch {
    return [];
  }
}
