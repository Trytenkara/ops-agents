import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeCompanyName } from "@/lib/tenkara-sourcing-exclusions";
import { isSameCompanyName } from "@/lib/fuzzy";

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ""); }
  catch { return null; }
}

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

  // Per-(material, supplier) dedup so re-fired discovery batches (SourceReady /
  // ImportYeti) don't stage the same supplier twice — the same rule the Agent 03
  // scout loop and the CSV bulk upload apply. Keyed on material_id + normalized
  // company name (folds "BASF" / "BASF SE"), with a fuzzy pass for typo variants
  // and a website-host check. Rows lacking a material_id or a name can't be keyed,
  // so they're always inserted.
  const materialIds = Array.from(
    new Set(parsed.data.leads.map((l) => l.material_id).filter((x): x is string => !!x))
  );
  type MatIndex = { names: string[]; hosts: Set<string> };
  const byMaterial = new Map<string, MatIndex>();
  const idxFor = (matId: string): MatIndex => {
    let m = byMaterial.get(matId);
    if (!m) { m = { names: [], hosts: new Set() }; byMaterial.set(matId, m); }
    return m;
  };
  if (materialIds.length) {
    const { data: existing } = await admin
      .from("leads_in_flight")
      .select("material_id, supplier_name, payload")
      .eq("status", "active")
      .in("material_id", materialIds);
    for (const r of existing ?? []) {
      const matId = (r.material_id as string) ?? "";
      if (!matId) continue;
      const ix = idxFor(matId);
      const nm = normalizeCompanyName(r.supplier_name as string | null);
      if (nm) ix.names.push(nm);
      const host = hostOf((r.payload as any)?.supplier_website ?? (r.payload as any)?.source_url);
      if (host) ix.hosts.add(host);
    }
  }
  const isDuplicate = (matId: string, name: string | null | undefined, host: string | null): boolean => {
    const ix = idxFor(matId);
    if (host && ix.hosts.has(host)) return true;
    const nm = normalizeCompanyName(name);
    if (!nm) return false;
    if (ix.names.includes(nm)) return true;
    return ix.names.some((e) => isSameCompanyName(nm, e));
  };

  let skippedDuplicate = 0;
  const rows: any[] = [];
  for (const l of parsed.data.leads) {
    const matId = l.material_id ?? null;
    const host = hostOf((l.payload as any)?.supplier_website ?? (l.payload as any)?.source_url);
    if (matId && l.supplier_name && isDuplicate(matId, l.supplier_name, host)) {
      skippedDuplicate++;
      continue;
    }
    // Register accepted rows so duplicates *within this same batch* are caught too.
    if (matId) {
      const ix = idxFor(matId);
      const nm = normalizeCompanyName(l.supplier_name);
      if (nm) ix.names.push(nm);
      if (host) ix.hosts.add(host);
    }
    rows.push({
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
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ inserted: 0, skipped_duplicate: skippedDuplicate });
  }
  const { data, error } = await admin.from("leads_in_flight").insert(rows).select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ inserted: data?.length ?? 0, skipped_duplicate: skippedDuplicate });
}
