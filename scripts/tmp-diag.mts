import { createClient } from "@supabase/supabase-js";
import { getOrgAssignmentContext, autoOperator, resolveOperatorId } from "../src/lib/operator-assignment";
import { leadMarketKind } from "../src/lib/lead-market";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

for (const slug of ["tenkara", "california-chemicals", "mcginley"]) {
  const { data: org } = await admin.from("orgs").select("id, slug, display_name, name").eq("slug", slug).maybeSingle();
  const ctx = await getOrgAssignmentContext(admin as any, org!.id);
  console.log(`\n=== ${slug} (${org!.display_name ?? org!.name}) mode=${ctx.config.mode} types=${ctx.config.supplierTypes} pool=${ctx.pool.length} autoPool=${ctx.autoPool.length} claims=${ctx.manual.size} typeKeys=${ctx.supplierTypes.size}`);
  console.log("  pool:", ctx.pool.map((p) => `${p.name}${p.autoAssignable ? "" : "(off)"}`).join(", "));

  const { data: leads } = await admin
    .from("leads_in_flight")
    .select("id, supplier_id, supplier_name, assigned_operator_id, payload")
    .eq("org_id", org!.id)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(300);

  const tally: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  for (const r of leads ?? []) {
    const kind = leadMarketKind((r.payload as any)?.site_type) ?? "unknown";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    const em = String((r.payload as any)?.supplier_contact_email ?? "").trim().toLowerCase();
    const key = r.supplier_id ?? (em ? `e:${em}` : r.id);
    const auto = autoOperator(ctx, key, kind === "unknown" ? null : (kind as any), r.supplier_name)?.name ?? null;
    const claim = r.supplier_id ? ctx.manual.get(r.supplier_id) ?? null : r.assigned_operator_id ?? null;
    const label = auto ? `auto:${auto}` : claim ? "claim-only" : "UNASSIGNED";
    tally[label] = (tally[label] ?? 0) + 1;
  }
  console.log("  site_type kinds:", kinds);
  console.log("  operator column (300 newest):", tally);
}
