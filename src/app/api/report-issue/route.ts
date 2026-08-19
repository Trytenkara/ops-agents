import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage, deepLink } from "@/lib/slack";


function slackSafe(value: string): string {
  return value.replace(/```/g, "''' ").replace(/[<>]/g, "").trim();
}

const schema = z.object({
  title: z.string().min(3).max(140),
  description: z.string().min(1).max(4000),
  page_path: z.string().max(512).regex(/^\/[A-Za-z0-9/_-]*$/).optional(),
  org_slug: z.string().max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
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
  const { data: reportId, error } = await admin.rpc("create_issue_report", {
    p_reporter_id: session.userId,
    p_reporter_email: session.email,
    p_title: title,
    p_description: description,
    p_page_path: page_path ?? null,
    p_org_slug: org_slug ?? null,
  });
  if (error?.message?.includes("issue_report_rate_limited")) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (error || !reportId) return NextResponse.json({ error: "insert_failed" }, { status: 500 });

  // Structured, machine-parseable message so the triage agent can pick up the
  // report id, the exact page, and who to reply to. Keep the ISSUE REPORT marker
  // and the fenced field block stable — the triage skill parses them.
  const text = [
    `*ISSUE REPORT* \`${reportId}\``,
    "```",
    `title: ${slackSafe(title)}`,
    `reporter: ${slackSafe(session.displayName ?? session.email)} (${slackSafe(session.email)})`,
    page_path ? `page: ${slackSafe(page_path)}` : null,
    org_slug ? `org: ${slackSafe(org_slug)}` : null,
    "---",
    slackSafe(description),
    "```",
    page_path ? `→ <${deepLink(page_path)}|Open the page>` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const slack = await postSlackMessage({ text });
  if (slack.ok && slack.ts) {
    await admin.from("issue_reports").update({ slack_message_ts: slack.ts }).eq("id", reportId);
  }

  return NextResponse.json({ ok: true, id: reportId });
}
