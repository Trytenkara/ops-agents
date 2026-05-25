import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const postSchema = z.object({
  org_slug: z.string(),
  type: z.enum(["supplier","quote","escalation_outcome","doc_refresh"]),
  payload: z.record(z.any()),
  notes: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id").eq("slug", parsed.data.org_slug).maybeSingle();
  if (!org) return NextResponse.json({ error: "org_not_found" }, { status: 404 });

  const { data, error } = await admin
    .from("pending_approvals")
    .insert({
      org_id: org.id,
      type: parsed.data.type,
      payload: parsed.data.payload,
      requested_by_agent: agent.id,
      notes: parsed.data.notes ?? null,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ approval_id: data.id });
}

export async function GET(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const url = new URL(request.url);
  const org_slug = url.searchParams.get("org_slug");
  const status = url.searchParams.get("status") ?? "pending";

  const admin = createAdminClient();
  let q = admin.from("pending_approvals").select("id, type, status, requested_at, payload").eq("status", status);
  if (org_slug) {
    const { data: org } = await admin.from("orgs").select("id").eq("slug", org_slug).maybeSingle();
    if (org) q = q.eq("org_id", org.id);
  }
  const { data, error } = await q.limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ approvals: data ?? [] });
}
