import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildSavingsReport } from "@/lib/savings-report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODEL = "claude-opus-4-8";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const SELECT_TOOL: Anthropic.Tool = {
  name: "select_materials",
  description:
    "Choose which materials appear in the client savings report and in what order, based on the operator's request.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional short subtitle for the report reflecting the request (e.g. 'Top 5 cost savings').",
      },
      note: {
        type: "string",
        description: "Optional one-sentence note if the request can't be fully met (e.g. fewer matches than asked).",
      },
      material_keys: {
        type: "array",
        items: { type: "string" },
        description:
          "The keys of the materials to include, in the exact display order desired. Use only keys from the provided list.",
      },
    },
    required: ["material_keys"],
  },
};

// POST /api/savings/custom-report  { slug, prompt }
// The operator's prompt reshapes the branded savings report: Claude only
// selects/orders which existing materials appear (never invents numbers).
// Returns the validated keys + optional title/note; the client renders the
// same card report filtered to those keys.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const slug = typeof body?.slug === "string" ? body.slug : null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!slug || !prompt) return NextResponse.json({ error: "slug and prompt required" }, { status: 400 });
  if (prompt.length > 2000) return NextResponse.json({ error: "prompt too long" }, { status: 400 });

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, name, tenkara_org_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "org not found" }, { status: 404 });
  if (!org.tenkara_org_id) return NextResponse.json({ error: "org not linked to Tenkara" }, { status: 400 });

  const report = await buildSavingsReport(org.tenkara_org_id);
  const keyOf = (l: { material_id: string; unit: string }) => `${l.material_id}|${l.unit}`;
  const validKeys = new Set(report.lines.map(keyOf));
  const catalog = report.lines.map((l) => ({
    key: keyOf(l),
    material: l.material_name,
    grade: l.grade,
    unit: l.unit,
    their_price: round(l.their_unit_price),
    best_tenkara_price: round(l.best_unit_price),
    savings_pct: round(l.savings_pct, 1),
    has_savings: l.savings_per_unit > 0,
  }));

  const system =
    "You shape a client savings report by choosing which materials to show and in what order. " +
    "Call select_materials with material_keys drawn ONLY from the provided catalog — never invent materials, prices, or savings. " +
    "Interpret the operator's request (e.g. 'top 5 cost savings', 'only >10% savings', 'sort by grade'). " +
    "If fewer materials match than requested, include the ones that do and add a brief note. " +
    "If the request is unclear, include all materials in a sensible order.";

  const userContent =
    `Client: ${org.name}\nCatalog (JSON): ${JSON.stringify(catalog)}\n\nOperator request: ${prompt}`;

  try {
    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      tools: [SELECT_TOOL],
      tool_choice: { type: "tool", name: "select_materials" },
      messages: [{ role: "user", content: userContent }],
    });

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "select_materials"
    );
    const input = (toolUse?.input ?? {}) as { title?: string; note?: string; material_keys?: unknown };
    const keys = Array.isArray(input.material_keys)
      ? input.material_keys.filter((k): k is string => typeof k === "string" && validKeys.has(k))
      : [];

    if (keys.length === 0) {
      return NextResponse.json({ error: "No matching materials for that request." }, { status: 422 });
    }
    // De-dup while preserving order.
    const seen = new Set<string>();
    const ordered = keys.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));

    return NextResponse.json({
      keys: ordered,
      title: typeof input.title === "string" ? input.title.slice(0, 120) : null,
      note: typeof input.note === "string" ? input.note.slice(0, 300) : null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "generation failed" }, { status: 500 });
  }
}

function round(n: number, places = 4): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}
