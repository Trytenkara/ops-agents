import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const caseSchema = z.object({
  org_slug: z.string(),
  type: z.enum(["price_change","lead_time_change","availability_change","quality_change","po_timing","client_info_request","archive_request","calling_escalation","other"]),
  supplier_id: z.string().optional(),
  material_id: z.string().optional(),
  originating_thread_id: z.string().optional(),
  classification_confidence: z.number().min(0).max(1).optional(),
  recommended_action: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

export async function POST(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const body = await request.json().catch(() => null);
  const parsed = caseSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id").eq("slug", parsed.data.org_slug).maybeSingle();
  if (!org) return NextResponse.json({ error: "org_not_found" }, { status: 404 });

  const { data, error } = await admin
    .from("cases")
    .insert({
      org_id: org.id,
      type: parsed.data.type,
      supplier_id: parsed.data.supplier_id ?? null,
      material_id: parsed.data.material_id ?? null,
      originating_thread_id: parsed.data.originating_thread_id ?? null,
      classification_confidence: parsed.data.classification_confidence ?? null,
      recommended_action: parsed.data.recommended_action ?? null,
      metadata: parsed.data.metadata ?? null,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ case_id: data.id });
}

export async function GET(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const url = new URL(request.url);
  const supplier_id = url.searchParams.get("supplier_id");
  const material_id = url.searchParams.get("material_id");
  const status = url.searchParams.get("status") ?? "open";

  const admin = createAdminClient();
  let q = admin.from("cases").select("id, type, status, supplier_id, material_id, created_at").eq("status", status);
  if (supplier_id) q = q.eq("supplier_id", supplier_id);
  if (material_id) q = q.eq("material_id", material_id);
  const { data, error } = await q.limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ cases: data ?? [] });
}
