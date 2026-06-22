import Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";

// Parse an uploaded PO document (PDF / CSV / text / xlsx) into structured order lines.
// PDFs are sent as a document content block (base64); CSV/text as plain text;
// xlsx workbooks are flattened to CSV text first.
// Extraction is forced through a single tool call so we always get structured
// JSON back (no free-text parsing).

const MODEL = "claude-sonnet-4-5";

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export interface OrderLine {
  material_label: string;
  supplier_name: string | null;
  order_date: string | null;     // ISO date (YYYY-MM-DD)
  ordered_qty: number | null;
  qty_unit: string | null;
  po_qty: number | null;
  unit_price: number | null;
  coa_expiry: string | null;     // ISO date
  material_expiry: string | null;// ISO date
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "record_order_lines",
  description: "Record every distinct material order line found in the purchase order document.",
  input_schema: {
    type: "object",
    properties: {
      orders: {
        type: "array",
        description: "One entry per material line item on the PO.",
        items: {
          type: "object",
          properties: {
            material_label: { type: "string", description: "Material / product name as written on the PO." },
            supplier_name: { type: ["string", "null"], description: "Supplier or vendor name, or null." },
            order_date: { type: ["string", "null"], description: "Order/PO date as YYYY-MM-DD, or null." },
            ordered_qty: { type: ["number", "null"], description: "Actual quantity ordered (numeric), or null." },
            qty_unit: { type: ["string", "null"], description: "Unit for the quantity (e.g. lb, kg), or null." },
            po_qty: { type: ["number", "null"], description: "Quantity stated on the PO if it differs from ordered_qty, else same or null." },
            unit_price: { type: ["number", "null"], description: "Price per unit (numeric), or null." },
            coa_expiry: { type: ["string", "null"], description: "COA expiry date as YYYY-MM-DD, or null." },
            material_expiry: { type: ["string", "null"], description: "Material/lot expiry date as YYYY-MM-DD, or null." },
          },
          required: ["material_label"],
        },
      },
    },
    required: ["orders"],
  },
};

const PROMPT =
  "Extract every material line item from this purchase order. For each line, capture the material name, " +
  "supplier, order date, quantity ordered and its unit, the PO quantity, unit price, and any COA or material " +
  "expiry dates. Use null for anything not present. Dates must be YYYY-MM-DD. Do not invent values. " +
  "Call record_order_lines with the results.";

function isPdf(mimeType: string, fileName: string): boolean {
  return mimeType === "application/pdf" || /\.pdf$/i.test(fileName);
}

function isXlsx(mimeType: string, fileName: string): boolean {
  return (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    /\.xlsx$/i.test(fileName)
  );
}

// Flatten an xlsx workbook to CSV text (one block per sheet) so the model can
// read it the same way it reads an uploaded CSV.
async function xlsxToText(bytes: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const parts: string[] = [];
  wb.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return "";
        if (typeof v === "object") {
          const o = v as { text?: string; result?: unknown; hyperlink?: string };
          return String(o.text ?? o.result ?? o.hyperlink ?? "");
        }
        return String(v);
      });
      rows.push(cells.join(","));
    });
    parts.push(`# Sheet: ${sheet.name}\n${rows.join("\n")}`);
  });
  return parts.join("\n\n");
}

// A single PO line in JSON is small, but a large purchasing history can hold
// hundreds of them — well past what one tool call can emit before hitting the
// output-token ceiling (a truncated tool call yields no usable orders at all).
// So tabular input (CSV / xlsx) is split into row batches and parsed per batch.
const MAX_TOKENS = 8000;
const PDF_MAX_TOKENS = 16000;
const ROWS_PER_CHUNK = 60;
const MAX_CONCURRENCY = 4;

function normalizeOrders(raw: unknown): OrderLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o: any): OrderLine => ({
    material_label: String(o.material_label ?? "").trim() || "Unknown material",
    supplier_name: o.supplier_name ?? null,
    order_date: o.order_date ?? null,
    ordered_qty: typeof o.ordered_qty === "number" ? o.ordered_qty : null,
    qty_unit: o.qty_unit ?? null,
    po_qty: typeof o.po_qty === "number" ? o.po_qty : null,
    unit_price: typeof o.unit_price === "number" ? o.unit_price : null,
    coa_expiry: o.coa_expiry ?? null,
    material_expiry: o.material_expiry ?? null,
  }));
}

async function extractFromBlock(
  documentBlock: Anthropic.ContentBlockParam,
  maxTokens: number
): Promise<OrderLine[]> {
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "record_order_lines" },
    messages: [{ role: "user", content: [documentBlock, { type: "text", text: PROMPT }] }],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_order_lines"
  );
  if (!toolUse) return [];
  return normalizeOrders((toolUse.input as { orders?: unknown }).orders);
}

// Run async tasks with a bounded number in flight so big files don't fan out
// into dozens of simultaneous API calls.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Split flattened tabular text into row batches, repeating the header row in
// each batch so every chunk is self-describing.
function chunkRows(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const header = lines.find((l) => l.includes(",")) ?? "";
  const dataLines = lines.filter(
    (l) => l.trim() && l !== header && !l.startsWith("# Sheet:")
  );
  if (dataLines.length === 0) return [text.slice(0, 100_000)];

  const chunks: string[] = [];
  for (let i = 0; i < dataLines.length; i += ROWS_PER_CHUNK) {
    const batch = dataLines.slice(i, i + ROWS_PER_CHUNK);
    chunks.push([header, ...batch].join("\n").slice(0, 100_000));
  }
  return chunks;
}

export async function parsePoDocument(opts: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<OrderLine[]> {
  const { bytes, mimeType, fileName } = opts;

  if (isPdf(mimeType, fileName)) {
    return extractFromBlock(
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
      },
      PDF_MAX_TOKENS
    );
  }

  const text = isXlsx(mimeType, fileName) ? await xlsxToText(bytes) : bytes.toString("utf8");
  const chunks = chunkRows(text);
  const perChunk = await mapPool(chunks, MAX_CONCURRENCY, (chunk) =>
    extractFromBlock({ type: "text", text: chunk }, MAX_TOKENS)
  );
  return perChunk.flat();
}

const DOC_TEXT_MAX = 20000;
const DOC_TRANSCRIBE_PROMPT =
  "Transcribe the information in this client document as concise plain text. Capture company details, " +
  "contacts, products, materials, volumes, pricing, terms, and anything relevant to sourcing for this client. " +
  "Be factual — do not invent or infer anything that isn't present.";

function isTextLike(mimeType: string, fileName: string): boolean {
  return /^text\/|markdown|json|csv/.test(mimeType) || /\.(txt|md|markdown|csv|tsv|json)$/i.test(fileName);
}

// General document → plain text, for feeding the client summary. Spreadsheets
// are flattened to CSV, text files read directly, and PDFs transcribed by the
// model. Returns null for formats we can't read (e.g. images) — callers store
// those for reference only. Never throws; logs and returns null on failure.
export async function extractDocumentText(opts: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<string | null> {
  const { bytes, mimeType, fileName } = opts;
  try {
    if (isXlsx(mimeType, fileName) || /\.xls$/i.test(fileName)) {
      const t = (await xlsxToText(bytes)).trim();
      return t ? t.slice(0, DOC_TEXT_MAX) : null;
    }
    if (isTextLike(mimeType, fileName)) {
      const t = bytes.toString("utf8").trim();
      return t ? t.slice(0, DOC_TEXT_MAX) : null;
    }
    if (isPdf(mimeType, fileName)) {
      const resp = await anthropic().messages.create({
        model: MODEL,
        max_tokens: 4000,
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } },
              { type: "text", text: DOC_TRANSCRIBE_PROMPT },
            ],
          },
        ],
      });
      const t = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return t ? t.slice(0, DOC_TEXT_MAX) : null;
    }
    return null;
  } catch (e) {
    console.error("[extractDocumentText] failed:", e);
    return null;
  }
}
