import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const postSchema = z.object({
  email_client: z.enum(["missive", "rod_app"]).default("missive"),
  thread_id: z.string(),
  draft_id: z.string(),
  agent_run_id: z.string().uuid().optional(),
  // Either org_slug OR tenkara_org_id may be passed. The Tenkara UUID is more convenient
  // for agents that already have it from a Tenkara DB query.
  org_slug: z.string().optional(),
  tenkara_org_id: z.string().uuid().optional(),
  supplier_id: z.string().optional(),
  material_id: z.string().optional(),
  // quote_id is the canonical de-dup key for the revalidation flow.
  // quote_ids accepts a list when a single Missive draft covers multiple expiring materials
  // for the same supplier — in that case we still store one draft_references row with
  // metadata.covered_quote_ids set to the full list, and quote_id is the primary (first) id.
  quote_id: z.string().optional(),
  quote_ids: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body_preview: z.string().max(2000).optional(),
  metadata: z.record(z.any()).optional(),
});

export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();

  // Resolve org + auto-assignment.
  let org_id: string | null = null;
  let assigned_operator: string | null = null;
  let orgRow: any = null;
  if (parsed.data.tenkara_org_id) {
    const { data } = await admin
      .from("orgs")
      .select("id, org_default_operators(primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(status))")
      .eq("tenkara_org_id", parsed.data.tenkara_org_id)
      .maybeSingle();
    orgRow = data;
  } else if (parsed.data.org_slug) {
    const { data } = await admin
      .from("orgs")
      .select("id, org_default_operators(primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(status))")
      .eq("slug", parsed.data.org_slug)
      .maybeSingle();
    orgRow = data;
  }
  if (orgRow) {
    org_id = orgRow.id;
    const ops = orgRow.org_default_operators?.[0] ?? orgRow.org_default_operators;
    if (ops) {
      const primaryOoo = ops.primary_user?.status === "out_of_office";
      assigned_operator = primaryOoo
        ? (ops.backup_user_id ?? ops.primary_user_id)
        : ops.primary_user_id;
    }
  }

  // Primary quote_id for de-dup is either the explicit field or the first of quote_ids.
  const primaryQuoteId = parsed.data.quote_id ?? parsed.data.quote_ids?.[0] ?? null;

  // De-dup: if a staged draft already exists for this (primary quote_id, agent), don't double-create.
  if (primaryQuoteId) {
    const { data: existing } = await admin
      .from("draft_references")
      .select("id")
      .eq("quote_id", primaryQuoteId)
      .eq("agent_id", agent.id)
      .eq("status", "staged")
      .maybeSingle();
    if (existing) return NextResponse.json({ draft_id: existing.id, deduped: true });
  }

  // If multiple quote_ids were passed, stash the full list in metadata so ops can see what's covered.
  const enrichedMetadata = parsed.data.quote_ids && parsed.data.quote_ids.length > 1
    ? { ...(parsed.data.metadata ?? {}), covered_quote_ids: parsed.data.quote_ids }
    : (parsed.data.metadata ?? null);

  const { data, error } = await admin
    .from("draft_references")
    .insert({
      email_client: parsed.data.email_client,
      thread_id: parsed.data.thread_id,
      draft_id: parsed.data.draft_id,
      agent_run_id: parsed.data.agent_run_id ?? null,
      agent_id: agent.id,
      org_id,
      supplier_id: parsed.data.supplier_id ?? null,
      material_id: parsed.data.material_id ?? null,
      quote_id: primaryQuoteId,
      subject: parsed.data.subject ?? null,
      body_preview: parsed.data.body_preview ?? null,
      assigned_operator,
      metadata: enrichedMetadata,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ draft_id: data.id, assigned_operator });
}

export async function GET(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const url = new URL(request.url);
  const quote_id = url.searchParams.get("quote_id");
  const supplier_id = url.searchParams.get("supplier_id");
  const material_id = url.searchParams.get("material_id");
  const status = url.searchParams.get("status") ?? "staged";

  const admin = createAdminClient();
  let q = admin.from("draft_references").select("id, status, thread_id, draft_id, subject, created_at, reviewed_at").eq("status", status);
  if (quote_id) q = q.eq("quote_id", quote_id);
  if (supplier_id) q = q.eq("supplier_id", supplier_id);
  if (material_id) q = q.eq("material_id", material_id);
  const { data, error } = await q.limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ drafts: data ?? [] });
}
