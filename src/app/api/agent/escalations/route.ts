import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage, deepLink } from "@/lib/slack";

const schema = z.object({
  org_slug: z.string().optional(),
  recommended_action: z.enum(["call_supplier", "archive_supplier", "feedback_to_enrichment", "escalate_to_ops_lead"]),
  trigger_quote_id: z.string().optional(),
  trigger_case_id: z.string().uuid().optional(),
  urgency: z.enum(["normal", "urgent"]).default("normal"),
  summary: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  let org_id: string | null = null;
  if (parsed.data.org_slug) {
    const { data: org } = await admin.from("orgs").select("id").eq("slug", parsed.data.org_slug).maybeSingle();
    org_id = org?.id ?? null;
  }

  const { data: esc, error } = await admin
    .from("escalations")
    .insert({
      org_id,
      recommended_action: parsed.data.recommended_action,
      trigger_quote_id: parsed.data.trigger_quote_id ?? null,
      trigger_case_id: parsed.data.trigger_case_id ?? null,
      urgency: parsed.data.urgency,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let slack_ts: string | undefined;
  if (parsed.data.urgency === "urgent") {
    const slackRes = await postSlackMessage({
      text: `:rotating_light: *[${agent.name}]* ${parsed.data.summary}\n→ <${deepLink(`/escalations/${esc.id}`)}|Open in Ops Assistants>`,
    });
    if (slackRes.ok) {
      slack_ts = slackRes.ts;
      await admin.from("escalations").update({ slack_message_ts: slack_ts }).eq("id", esc.id);
    }
  }

  return NextResponse.json({ escalation_id: esc.id, slack_message_ts: slack_ts ?? null });
}
