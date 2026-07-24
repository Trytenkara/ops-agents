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

const META_TOOL: Anthropic.Tool = {
  name: "set_report_meta",
  description:
    "Record the run metadata and editorial notes for the expedited sourcing report, extracted ONLY from what the operator wrote. Omit any field the operator did not state — never guess run IDs, dates, or counts.",
  input_schema: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "Run identifier, e.g. 'TK-0722'." },
      run_dates: { type: "string", description: "Date range the run covered, e.g. 'Jul 19–22, 2026'." },
      run_duration: { type: "string", description: "How long the run took, e.g. '72 hrs'." },
      intro: { type: "string", description: "One-sentence intro line under the client name." },
      scope: { type: "string", description: "Scope line for the methodology grid." },
      prospects_identified: { type: "integer", description: "Number of prospective suppliers identified." },
      suppliers_validated: { type: "integer", description: "Number of suppliers validated." },
      quotes_returned: { type: "integer", description: "Number of qualified quotes returned." },
      material_notes: {
        type: "array",
        description: "Per-material impact/editorial notes.",
        items: {
          type: "object",
          properties: {
            material: { type: "string", description: "Material name, matched to the provided list." },
            note: { type: "string", description: "The impact/editorial line for that material." },
          },
          required: ["material", "note"],
        },
      },
    },
  },
};

// POST /api/savings/expedited-meta  { slug, prompt }
// Parses the operator's free-text into the run metadata the DB doesn't carry
// (run ID/dates, funnel counts, editorial notes). Extraction only — Claude never
// invents figures; omitted fields stay gaps. The client overlays the result onto
// the derived report.
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
  if (prompt.length > 4000) return NextResponse.json({ error: "prompt too long" }, { status: 400 });

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, name, tenkara_org_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "org not found" }, { status: 404 });
  if (!org.tenkara_org_id) return NextResponse.json({ error: "org not linked to Tenkara" }, { status: 400 });

  const report = await buildSavingsReport(org.tenkara_org_id);
  const materialNames = Array.from(new Set(report.lines.map((l) => l.material_name)));

  const system =
    "You extract run metadata for a client sourcing report from the operator's message. " +
    "Call set_report_meta with ONLY the fields the operator actually stated — do not invent run IDs, dates, or counts. " +
    "For material_notes, match each note to a material name from the provided list (use the exact name). " +
    "If the operator stated nothing extractable, call the tool with no fields.";

  const userContent = `Materials in this report: ${JSON.stringify(materialNames)}\n\nOperator message: ${prompt}`;

  try {
    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      tools: [META_TOOL],
      tool_choice: { type: "tool", name: "set_report_meta" },
      messages: [{ role: "user", content: userContent }],
    });

    const toolUse = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "set_report_meta"
    );
    const input = (toolUse?.input ?? {}) as Record<string, unknown>;

    const validNames = new Set(materialNames);
    const notes = Array.isArray(input.material_notes)
      ? (input.material_notes as any[])
          .filter((n) => n && typeof n.material === "string" && typeof n.note === "string" && validNames.has(n.material))
          .map((n) => ({ material: n.material as string, note: (n.note as string).slice(0, 300) }))
      : [];

    const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);

    return NextResponse.json({
      run_id: str(input.run_id, 40),
      run_dates: str(input.run_dates, 60),
      run_duration: str(input.run_duration, 40),
      intro: str(input.intro, 300),
      scope: str(input.scope, 200),
      prospects_identified: int(input.prospects_identified),
      suppliers_validated: int(input.suppliers_validated),
      quotes_returned: int(input.quotes_returned),
      material_notes: notes,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "extraction failed" }, { status: 500 });
  }
}
