import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Agent-facing write-back for the triage loop. The agent updates a report's
// status/classification/resolution/pr_url as it works, so operators watch the
// loop close from the app. GET returns open reports for the agent to pick up.

const patchSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["new", "triaging", "auto_fixing", "awaiting_approval", "deployed", "wont_fix"]).optional(),
  classification: z.enum(["trivial", "gated", "feature"]).optional(),
  resolution: z.string().max(4000).optional(),
  pr_url: z.string().url().optional(),
});

export async function GET(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const admin = createAdminClient();
  const { data } = await admin
    .from("issue_reports")
    .select("id, title, description, page_path, org_slug, reporter_email, status, classification, created_at")
    .not("status", "in", "(deployed,wont_fix)")
    .order("created_at", { ascending: true });
  return NextResponse.json({ reports: data ?? [] });
}

export async function PATCH(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { id, ...fields } = parsed.data;
  const patch: Record<string, unknown> = { ...fields };
  if (fields.status === "deployed" || fields.status === "wont_fix") {
    patch.resolved_at = new Date().toISOString();
  }

  const admin = createAdminClient();
  const { error } = await admin.from("issue_reports").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
  return NextResponse.json({ ok: true });
}
