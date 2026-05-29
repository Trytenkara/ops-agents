import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSession } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { RUNBOOK_KNOWLEDGE, buildUserContext } from "@/lib/runbook/knowledge";
import { TOOL_DEFS, runRunbookTool } from "@/lib/runbook/tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sonnet for snappier chat latency while keeping reliable tool use. Bump to
// claude-opus-4-5 here if answer quality on complex questions regresses.
const MODEL = "claude-sonnet-4-5";
const MAX_TURNS = 6; // safety cap on the tool-use loop

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function POST(request: NextRequest) {
  // Middleware skips /api/*, so this route owns its auth.
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const incoming = Array.isArray(body?.messages) ? body.messages : null;
  if (!incoming || incoming.length === 0) {
    return NextResponse.json({ error: "messages[] required" }, { status: 400 });
  }

  const messages: Anthropic.MessageParam[] = incoming
    .filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
    .map((m: any) => ({ role: m.role, content: m.content }));
  if (messages.length === 0) {
    return NextResponse.json({ error: "no valid messages" }, { status: 400 });
  }

  // Build the per-user context block (org-scoped).
  const allOrgs = seesAllOrgs(session);
  let orgNames: string[] = [];
  if (!allOrgs) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned && assigned.length > 0) {
      const { data } = await createAdminClient().from("orgs").select("name").in("id", assigned).order("name");
      orgNames = (data ?? []).map((o: any) => o.name);
    }
  }

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: RUNBOOK_KNOWLEDGE, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildUserContext(session, { seesAllOrgs: allOrgs, orgNames }) },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const turnStream = anthropic().messages.stream({
            model: MODEL,
            max_tokens: 1500,
            system,
            tools: TOOL_DEFS,
            messages,
          });
          turnStream.on("text", (delta) => controller.enqueue(encoder.encode(delta)));
          const final = await turnStream.finalMessage();

          if (final.stop_reason !== "tool_use") break;

          // Execute every requested tool (scoped to this session) and feed results back.
          const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            let result: unknown;
            try {
              result = await runRunbookTool(tu.name, (tu.input ?? {}) as Record<string, any>, session);
            } catch (e: any) {
              result = { error: e?.message ?? "tool failed" };
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify(result),
            });
          }
          messages.push({ role: "assistant", content: final.content });
          messages.push({ role: "user", content: toolResults });
        }
      } catch (e: any) {
        controller.enqueue(encoder.encode(`\n\n[assistant error: ${e?.message ?? "unknown"}]`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
