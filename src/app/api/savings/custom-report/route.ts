import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildSavingsReport } from "@/lib/savings-report";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Opus for report-quality prose; this is not latency-sensitive.
const MODEL = "claude-opus-4-8";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// POST /api/savings/custom-report  { slug, prompt }
// Ad-hoc savings report: hands the client's per-material savings data to Claude
// along with the operator's free-form formatting request, returns markdown.
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
  const rows = report.lines.map((l) => ({
    material: l.material_name,
    grade: l.grade,
    unit: l.unit,
    their_price: round(l.their_unit_price),
    best_tenkara_price: round(l.best_unit_price),
    recommended_supplier: l.recommended_supplier_name,
    savings_per_unit: round(l.savings_per_unit),
    savings_pct: round(l.savings_pct, 1),
    market_avg: round(l.market_avg_unit_price),
    quotes: l.n_quotes,
    suppliers: l.n_suppliers,
  }));

  const system =
    "You are a procurement analyst at Tenkara producing a client-facing sourcing report. " +
    "You are given a client's per-material savings data (their current price vs the cheapest Tenkara-sourced supplier, normalized per unit) as JSON. " +
    "Produce a clear, well-structured report in Markdown that fulfills the operator's request. " +
    "Only use the numbers provided — never invent prices, suppliers, freight, or savings. " +
    "If the request asks for data you don't have, say so briefly rather than fabricating it.";

  const userContent =
    `Client: ${org.name}\n` +
    `Savings data (JSON): ${JSON.stringify(rows)}\n\n` +
    `Operator request: ${prompt}`;

  try {
    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userContent }],
    });
    if (msg.stop_reason === "refusal") {
      return NextResponse.json({ error: "request was declined" }, { status: 422 });
    }
    const markdown = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return NextResponse.json({ markdown });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "generation failed" }, { status: 500 });
  }
}

function round(n: number, places = 4): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}
