import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Resolve the rules cascade: supplier → material → org → agent-global → built-in default.
// "Most specific scope wins" per §4.5/4.9. Returns one rule per rule_type.

export async function GET(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const url = new URL(request.url);
  const org_slug = url.searchParams.get("org_slug");
  const supplier_id = url.searchParams.get("supplier_id");
  const material_id = url.searchParams.get("material_id");

  const admin = createAdminClient();
  let org_id: string | null = null;
  if (org_slug) {
    const { data: org } = await admin.from("orgs").select("id").eq("slug", org_slug).maybeSingle();
    org_id = org?.id ?? null;
  }

  const { data: rules } = await admin
    .from("agent_rules")
    .select("rule_type, rule_value, scope_type, scope_id")
    .eq("agent_id", agent.id)
    .eq("active", true);

  const specificity = { supplier: 4, material: 3, org: 2, global: 1 } as const;
  const resolved: Record<string, { value: any; scope: string; scope_id: string | null }> = {};

  for (const r of rules ?? []) {
    const scope = r.scope_type as keyof typeof specificity;
    let matches = false;
    if (scope === "global") matches = true;
    else if (scope === "org") matches = !!org_id && r.scope_id === org_id;
    else if (scope === "supplier") matches = !!supplier_id && r.scope_id === supplier_id;
    else if (scope === "material") matches = !!material_id && r.scope_id === material_id;
    if (!matches) continue;
    const existing = resolved[r.rule_type];
    if (!existing || specificity[scope] > specificity[existing.scope as keyof typeof specificity]) {
      resolved[r.rule_type] = { value: r.rule_value, scope, scope_id: r.scope_id };
    }
  }

  return NextResponse.json({ agent_slug: agent.slug, resolved });
}
