import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const schema = z.object({
  org_slug: z.string().optional(),
  agent_run_id: z.string().uuid().optional(),
  leads: z.array(z.object({
    supplier_name: z.string().optional(),
    supplier_id: z.string().optional(),
    material_name: z.string().optional(),
    material_id: z.string().optional(),
    stage: z.enum(["raw_discovery", "gap_analysis", "approval", "exported"]),
    status: z.enum(["active", "dropped", "terminal"]).default("active"),
    source: z.string().optional(),
    payload: z.record(z.any()).optional(),
    drop_reason: z.string().optional(),
    confidence_score: z.number().min(0).max(1).optional(),
  })),
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

  const rows = parsed.data.leads.map((l) => ({
    org_id,
    agent_run_id: parsed.data.agent_run_id ?? null,
    supplier_name: l.supplier_name ?? null,
    supplier_id: l.supplier_id ?? null,
    material_name: l.material_name ?? null,
    material_id: l.material_id ?? null,
    stage: l.stage,
    status: l.status,
    source: l.source ?? null,
    payload: l.payload ?? null,
    drop_reason: l.drop_reason ?? null,
    confidence_score: l.confidence_score ?? null,
  }));

  const { data, error } = await admin.from("leads_in_flight").insert(rows).select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ inserted: data?.length ?? 0 });
}
