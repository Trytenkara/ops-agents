import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { postSlackMessage, deepLink } from "@/lib/slack";

const schema = z.object({
  text: z.string().min(1).max(3000),
  deep_link_path: z.string().optional(),
  urgency: z.enum(["normal", "urgent"]).default("normal"),
  context: z.object({
    org: z.string().optional(),
    supplier: z.string().optional(),
    material: z.string().optional(),
  }).optional(),
});

export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const ctx = parsed.data.context;
  const contextLine = ctx ? [ctx.org, ctx.supplier, ctx.material].filter(Boolean).join(" · ") : "";
  const lines = [
    `*[${agent.name}]* ${parsed.data.text}`,
    contextLine ? `_${contextLine}_` : null,
    parsed.data.deep_link_path ? `→ <${deepLink(parsed.data.deep_link_path)}|Open in Ops Assistants>` : null,
  ].filter(Boolean).join("\n");

  const res = await postSlackMessage({ text: lines });
  return NextResponse.json(res);
}
