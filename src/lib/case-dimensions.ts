import Anthropic from "@anthropic-ai/sdk";

// Determine OUTER shippable-unit case dimensions for a staged quote, following
// the ops case-dimension SOP, for freight rate calc on Tenkara. Read-only,
// best-effort: any failure returns null so staging is never blocked. Output maps
// 1:1 onto Tenkara material_quotes.case_type + case_dimensions.

const MODEL = "claude-sonnet-4-5";

export interface CaseDimensions {
  unit: "in";
  width: number | null;
  height: number | null;
  length: number | null;
  packaging_case_weight: number | null; // kg
}

export interface CaseDimensionResult {
  case_type: "Box/Bag" | "Drum" | "Tote";
  case_dimensions: CaseDimensions;
  dim_source: "supplier" | "ai_estimated";
}

export interface CaseDimensionInput {
  materialName?: string | null;
  caseSize?: number | string | null;
  unitOfMeasurement?: string | null;
  moq?: string | null;
  grade?: string | null;
  raw?: unknown;
}

const SYSTEM = `You are a case-dimension advisor for a procurement team. Determine accurate OUTER case dimensions for shipping/freight quoting, strictly following the SOP below. Output data only, no prose.

CASE TYPES (pick by how the supplier SHIPS the item, not how it is used):
- "Box/Bag": bags, sacks, or boxed items that ship individually or in cases.
- "Drum": standard and non-standard drums and pails of any size.
- "Tote": bulk bags, super sacks, IBC packaging that ship one unit per pallet.

DIMENSION RULES:
- Dimensions are the OUTER dimensions of the shippable unit, in INCHES. Account for outer packaging (box walls, bag thickness).
- Use the shippable-unit dimensions, NOT the product's internal/net dimensions.
- For items shipped only in bundled quantities, use the bundled/case dimensions, not individual-unit dimensions.
- NEVER use pallet dimensions.
- Bags/sacks laid flat on a pallet: HEIGHT = the thickness when laid flat, not the standing height.
- Drums: use the drum's outer diameter for BOTH width and length; height = drum height.
- If the supplier explicitly provides dimensions, use them EXACTLY and set dim_source="supplier". Otherwise estimate standard industry dimensions and set dim_source="ai_estimated".

WEIGHT:
- weight_kg = total shippable-unit weight (net contents + packaging) in KILOGRAMS. Convert if the input weight/case_size is in lb (1 lb = 0.453592 kg).

You are given a quote's packaging facts (material, case size + unit, MOQ, grade, and any raw extracted text). Infer the single most likely shippable unit and return ONLY a JSON object with EXACTLY these keys:
{"case_type": "Box/Bag|Drum|Tote", "width_in": number, "height_in": number, "length_in": number, "weight_kg": number, "dim_source": "supplier|ai_estimated"}
Numbers must be plain numbers (no units, no strings). Do not wrap the JSON in markdown.`;

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

function userText(inp: CaseDimensionInput): string {
  const lines = [`material: ${inp.materialName ?? "unknown"}`];
  if (inp.caseSize != null && inp.caseSize !== "") {
    lines.push(`case_size: ${inp.caseSize} ${inp.unitOfMeasurement ?? ""}`.trim());
  }
  if (inp.moq) lines.push(`MOQ: ${inp.moq}`);
  if (inp.grade) lines.push(`grade: ${inp.grade}`);
  if (inp.raw != null) {
    const raw = typeof inp.raw === "string" ? inp.raw : JSON.stringify(inp.raw);
    if (raw && raw !== "{}") lines.push(`raw extracted packaging text: ${raw.slice(0, 1500)}`);
  }
  return lines.join("\n");
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Returns case type + dimensions, or null on any failure (caller must not block
// on it). If the model produces no usable dimensions, returns null.
export async function computeCaseDimensions(
  inp: CaseDimensionInput
): Promise<CaseDimensionResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM,
      messages: [{ role: "user", content: userText(inp) }],
    });
    let text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    const j = JSON.parse(text.slice(start, end + 1));

    const ct = j.case_type === "Drum" || j.case_type === "Tote" ? j.case_type : "Box/Bag";
    const dims: CaseDimensions = {
      unit: "in",
      width: num(j.width_in),
      height: num(j.height_in),
      length: num(j.length_in),
      packaging_case_weight: num(j.weight_kg),
    };
    if (dims.width == null && dims.height == null && dims.length == null) return null;
    return {
      case_type: ct,
      case_dimensions: dims,
      dim_source: j.dim_source === "supplier" ? "supplier" : "ai_estimated",
    };
  } catch {
    return null;
  }
}
