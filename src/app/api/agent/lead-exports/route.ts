import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage } from "@/lib/slack";

// Queue a per-supplier CSV for the export handoff (§5.4). Phase 3 work, but
// stubbed here so agents can already write to the queue.

const schema = z.object({
  supplier_name: z.string().optional(),
  supplier_id: z.string().optional(),
  csv_payload: z.string(),
  send_to_slack: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("lead_scanner_exports")
    .insert({
      supplier_name: parsed.data.supplier_name ?? null,
      // ORG-10: this queue carries no client, and "whose supplier is this" has
      // no answer without one, so the caller's id cannot be checked and is not
      // stored. The name is the honest identifier here.
      supplier_id: null,
      csv_payload: parsed.data.csv_payload,
      status: parsed.data.send_to_slack ? "sent" : "queued",
      generated_by_agent: agent.id,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let slack_ts: string | undefined;
  if (parsed.data.send_to_slack) {
    const slackRes = await postSlackMessage({
      text: `Lead Scanner export for *${parsed.data.supplier_name ?? "supplier"}*: please upload to the catalog. CSV stored at export ${row.id}.`,
    });
    if (slackRes.ok) {
      slack_ts = slackRes.ts;
      await admin.from("lead_scanner_exports").update({ slack_message_ts: slack_ts }).eq("id", row.id);
    }
  }

  return NextResponse.json({ export_id: row.id, slack_message_ts: slack_ts ?? null });
}
