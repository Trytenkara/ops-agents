import Anthropic from "@anthropic-ai/sdk";
import type { MissiveAttachment } from "@/lib/missive";

// Extract supplier pricing from email attachments. Pricing frequently arrives
// as a PDF quote, a scanned/photographed price sheet, or a CSV — not just inline
// reply text. We fetch the attachment bytes (Missive serves a signed URL) and
// hand them to Claude as a document/image/text block to pull structured quote
// lines. Read-only: this only produces extracted data; nothing is sent anywhere.

const MODEL = "claude-sonnet-4-5";
const MAX_OUTPUT_TOKENS = 2048;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB cap — skip giant files.

export interface ExtractedQuote {
  supplier_name: string | null;
  material_name: string | null;
  price: number | null; // per-case price, currency-stripped
  case_size: number | null;
  unit_of_measurement: string | null;
  currency: string | null;
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
      "case_size": 25,                // numeric quantity the price covers (e.g. 25 for a 25 kg bag); null if unclear
      "unit_of_measurement": "kg",    // the unit case_size is in (kg, lb, L, each, ...)
      "currency": "USD",
      "confidence": "high | medium | low",
      "notes": "anything ambiguous: MOQ, tiered pricing, unclear unit, etc."
    }
  ]
}

Rules:
- price must be numeric or null. Strip "$", "USD", commas.
- If the price is per-unit and no case size is given, set case_size = 1 and unit_of_measurement to that unit.
- confidence "low" when the unit/case size is guessed or the figure might be an MOQ/sample price rather than a real quote.
- Never invent materials. If the document has no extractable price lines, return {"quotes": []}.`;

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

// Which attachments are worth parsing for pricing.
export function isPricingCandidate(att: MissiveAttachment): boolean {
  const ext = (att.extension ?? att.sub_type ?? "").toLowerCase();
  const PRICE_EXT = ["pdf", "csv", "png", "jpg", "jpeg", "webp", "gif", "tsv", "txt"];
  // xlsx/xls are binary spreadsheets Claude can't read natively — skip in v1.
  return PRICE_EXT.includes(ext) && (att.size ?? 0) <= MAX_BYTES;
}

async function fetchBytes(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) return null;
  return { buf: Buffer.from(ab), contentType };
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

// Parse a single attachment into quote lines. Returns [] on any failure (the
// caller logs and moves on — a bad attachment shouldn't fail the agent run).
export async function parseAttachment(att: MissiveAttachment): Promise<ExtractedQuote[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  if (!isPricingCandidate(att)) return [];

  const fetched = await fetchBytes(att.url);
  if (!fetched) return [];
  const ext = (att.extension ?? att.sub_type ?? "").toLowerCase();

  let contentBlock: Anthropic.ContentBlockParam;
  if (ext === "pdf") {
    contentBlock = {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: fetched.buf.toString("base64") },
    };
  } else if (imageMediaType(ext)) {
    contentBlock = {
      type: "image",
      source: { type: "base64", media_type: imageMediaType(ext)!, data: fetched.buf.toString("base64") },
    };
  } else {
    // csv / tsv / txt — send as text.
    const text = fetched.buf.toString("utf-8").slice(0, 200_000);
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
          { type: "text", text: `Filename: ${att.filename}. Extract all price quote lines as JSON.` },
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
      unit_of_measurement: q.unit_of_measurement ?? null,
      currency: q.currency ?? "USD",
      confidence: ["high", "medium", "low"].includes(q.confidence) ? q.confidence : "low",
      notes: q.notes ?? null,
    }));
}

// Parse all pricing-candidate attachments on a message.
export async function parseMessageAttachments(
  attachments: MissiveAttachment[] | undefined
): Promise<{ attachment: MissiveAttachment; quotes: ExtractedQuote[] }[]> {
  if (!attachments?.length) return [];
  const out: { attachment: MissiveAttachment; quotes: ExtractedQuote[] }[] = [];
  for (const att of attachments) {
    if (!isPricingCandidate(att)) continue;
    try {
      const quotes = await parseAttachment(att);
      if (quotes.length) out.push({ attachment: att, quotes });
    } catch {
      // best-effort: skip unparseable attachment
    }
  }
  return out;
}
