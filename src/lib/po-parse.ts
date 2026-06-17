import Anthropic from "@anthropic-ai/sdk";

// Parse an uploaded PO document (PDF / CSV / text) into structured order lines.
// PDFs are sent as a document content block (base64); CSV/text as plain text.
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

export async function parsePoDocument(opts: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<OrderLine[]> {
  const { bytes, mimeType, fileName } = opts;

  const documentBlock: Anthropic.ContentBlockParam = isPdf(mimeType, fileName)
    ? {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") },
      }
    : { type: "text", text: bytes.toString("utf8").slice(0, 100_000) };

  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 8000,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "record_order_lines" },
    messages: [
      { role: "user", content: [documentBlock, { type: "text", text: PROMPT }] },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_order_lines"
  );
  if (!toolUse) return [];

  const raw = (toolUse.input as { orders?: unknown }).orders;
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
