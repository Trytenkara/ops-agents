import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage, deepLink } from "@/lib/slack";

// #control-room-feedback. The agent's operator-feedback Slack trigger listens
// here, so posting a structured report to this channel is what kicks off triage.
const FEEDBACK_CHANNEL_ID = process.env.SLACK_FEEDBACK_CHANNEL_ID ?? "C0BATUWBHC7";

const schema = z.object({
  title: z.string().min(3).max(140),
  description: z.string().min(1).max(4000),
  page_path: z.string().max(512).optional(),
  org_slug: z.string().max(200).optional(),
});

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { title, description, page_path, org_slug } = parsed.data;

  const admin = createAdminClient();
  const { data: report, error } = await admin
    .from("issue_reports")
    .insert({
      reporter_id: session.userId,
      reporter_email: session.email,
      title,
      description,
      page_path: page_path ?? null,
      org_slug: org_slug ?? null,
    })
    .select("id")
    .single();

  if (error || !report) {
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  // Structured, machine-parseable message so the triage agent can pick up the
  // report id, the exact page, and who to reply to. Keep the ISSUE REPORT marker
  // and the fenced field block stable — the triage skill parses them.
  const text = [
    `🐞 *ISSUE REPORT* \`${report.id}\``,
    "```",
    `title: ${title}`,
    `reporter: ${session.displayName ?? session.email} <${session.email}>`,
    page_path ? `page: ${page_path}` : null,
    org_slug ? `org: ${org_slug}` : null,
    "---",
    description,
    "```",
    page_path ? `→ <${deepLink(page_path)}|Open the page>` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const slack = await postSlackMessage({ channel: FEEDBACK_CHANNEL_ID, text });
  if (slack.ok && slack.ts) {
    await admin.from("issue_reports").update({ slack_message_ts: slack.ts }).eq("id", report.id);
  }

  return NextResponse.json({ ok: true, id: report.id });
}
